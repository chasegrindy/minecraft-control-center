import argparse
import io
import json
import math
import os
import socket
import struct
import time
from datetime import datetime, timezone
from pathlib import Path


def game_process(root):
    matches = []
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if (process / "cwd").resolve(strict=True) == root and (process / "exe").resolve(strict=True).name == "java":
                matches.append(process)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    if len(matches) != 1:
        raise RuntimeError("Expected one Java process for the selected instance")
    return matches[0]


def proc_values(file):
    return dict(line.split(":", 1) for line in file.read_text().splitlines() if ":" in line)


def sample(process):
    clock = time.monotonic()
    fields = (process / "stat").read_text().rsplit(")", 1)[1].split()
    cpu_ticks = int(fields[11]) + int(fields[12])
    started = int(fields[19])
    rss_bytes = int(proc_values(process / "status")["VmRSS"].split()[0]) * 1024
    try:
        write_bytes = int(proc_values(process / "io")["write_bytes"])
    except PermissionError:
        write_bytes = None
    return clock, started, cpu_ticks, rss_bytes, write_bytes


def summarize(values):
    if not values:
        return None
    ordered = sorted(values)
    return {
        "mean": round(sum(ordered) / len(ordered), 3),
        "p95": round(ordered[math.ceil(0.95 * len(ordered)) - 1], 3),
        "max": round(ordered[-1], 3),
    }


def encode_varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def read_varint(stream):
    result = 0
    for shift in range(0, 35, 7):
        part = stream.read(1)
        if not part:
            raise ValueError("Incomplete Minecraft status")
        result |= (part[0] & 127) << shift
        if part[0] < 128:
            return result
    raise ValueError("Invalid Minecraft status")


def online_players(port):
    address = b"127.0.0.1"
    # The status handshake format for Minecraft Java 1.21.11.
    handshake = b"\0" + encode_varint(774) + encode_varint(len(address)) + address + struct.pack("!H", port) + b"\1"
    try:
        with socket.create_connection((address.decode(), port), timeout=0.75) as connection:
            connection.sendall(encode_varint(len(handshake)) + handshake + b"\1\0")
            with connection.makefile("rb") as stream:
                size = read_varint(stream)
                if not 0 < size <= 128 * 1024:
                    return None
                packet = io.BytesIO(stream.read(size))
                if packet.getbuffer().nbytes != size or read_varint(packet) != 0:
                    return None
                length = read_varint(packet)
                data = packet.read()
                if length != len(data):
                    return None
        count = json.loads(data).get("players", {}).get("online")
        return count if type(count) is int and 0 <= count <= 100000 else None
    except (OSError, ValueError, AttributeError):
        return None


def capabilities(root):
    flags = {key: False for key in ("enable-jmx-monitoring", "management-server-enabled")}
    for line in (root / "server.properties").read_text(encoding="utf-8", errors="replace").splitlines():
        key, _, value = line.partition("=")
        if key.strip() in flags:
            flags[key.strip()] = value.strip().lower() == "true"
    jar_names = {file.name.lower() for file in (root / "mods").glob("*.jar") if file.is_file()}
    return {"modJarCount": len(jar_names),
            "metricModFilenames": sorted(prefix for prefix in ("spark", "vania", "fabricexporter", "prometheus", "carpet", "tabtps")
                                         if any(name.startswith(prefix) for name in jar_names)),
            "flags": flags}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--samples", type=int, default=30, choices=range(1, 181), metavar="1–180")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--status-port", type=int, metavar="PORT", help="sample Minecraft's player count on loopback")
    args = parser.parse_args()
    if not 1 <= args.interval <= 10 or args.samples * args.interval > 300:
        parser.error("Use 1–10 second samples and a run of up to 300 seconds")
    if args.status_port is not None and not 1 <= args.status_port <= 65535:
        parser.error("Use a status port from 1 to 65535")
    root = args.root.resolve(strict=True)
    process = game_process(root)
    flags = capabilities(root)
    try:
        game_cores = len(os.sched_getaffinity(int(process.name)))
    except PermissionError:
        game_cores = None
    started_at = datetime.now(timezone.utc)
    tick_rate = os.sysconf("SC_CLK_TCK")
    first = sample(process)
    previous = first
    cpu = []
    rss = []
    writes = []
    player_counts = []
    player_misses = 0
    next_status_sample = first[0]
    for index in range(1, args.samples + 1):
        due = first[0] + index * args.interval
        time.sleep(max(0, due - time.monotonic()))
        current = sample(process)
        if current[1] != first[1] or current[2] < previous[2]:
            raise RuntimeError("Game process changed during the read")
        duration = current[0] - previous[0]
        cpu.append(100 * (current[2] - previous[2]) / (tick_rate * duration))
        rss.append(current[3] / 2 ** 20)
        if current[4] is not None and previous[4] is not None and current[4] >= previous[4]:
            writes.append((current[4] - previous[4]) / (duration * 2 ** 20))
        if args.status_port is not None and current[0] >= next_status_sample:
            next_status_sample = due + 10
            count = online_players(args.status_port)
            if count is None:
                player_misses += 1
            else:
                player_counts.append(count)
        previous = current
    print(json.dumps({
        "startedAt": started_at.isoformat(timespec="seconds"), "seconds": round(previous[0] - first[0], 3),
        "samples": len(cpu), "hostArch": os.uname().machine, "logicalCores": len(os.sched_getaffinity(0)),
        "gameCores": game_cores,
        "cpuOneCorePct": summarize(cpu), "rssMiB": summarize(rss), "writeMiBPerSec": summarize(writes),
        "writeSamples": len(writes), "sources": flags,
        "onlinePlayers": None if args.status_port is None else {
            "counts": sorted(set(player_counts)), "samples": len(player_counts), "misses": player_misses,
        },
    }))


if __name__ == "__main__":
    main()
