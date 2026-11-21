import argparse
import gzip
import json
import os
import re
import stat
import struct
import zlib
from datetime import datetime, timezone
from pathlib import Path

identifier = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", re.I)
player_name = re.compile(r"[A-Za-z0-9_]{1,16}")
world_name = re.compile(r"[A-Za-z0-9_-]{1,64}")
dimensions = {
    b"minecraft:overworld": "overworld",
    b"minecraft:the_nether": "nether",
    b"minecraft:the_end": "end",
}
nbt_limit = 2 * 1024 * 1024
item_id = re.compile(rb"[a-z0-9_.-]+:[a-z0-9_/.-]+")
equipment_slots = {b"feet": "feet", b"legs": "legs", b"chest": "chest", b"head": "head", b"offhand": "offhand"}
legacy_equipment = {100: "feet", 101: "legs", 102: "chest", 103: "head", 150: "offhand"}


def entries(root, filename, captured):
    file = root / filename
    try:
        if file.stat().st_size > 512_000:
            raise ValueError("Player file exceeded size limit")
        data = json.loads(file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    if not isinstance(data, list) or len(data) > 2000:
        raise ValueError("Unexpected player data")
    result = []
    for item in data:
        if not isinstance(item, dict):
            raise ValueError("Unexpected player entry")
        name, uuid = item.get("name"), item.get("uuid")
        if not isinstance(name, str) or not player_name.fullmatch(name):
            continue
        if not isinstance(uuid, str) or not identifier.fullmatch(uuid):
            continue
        row = {"name": name, "uuid": uuid.lower()}
        if filename == "ops.json":
            level = item.get("level")
            if type(level) is not int or not 0 <= level <= 4:
                raise ValueError("Unexpected operator level")
            row["level"] = level
        if filename == "banned-players.json":
            expires = item.get("expires", "forever")
            if expires != "forever":
                end = datetime.strptime(expires, "%Y-%m-%d %H:%M:%S %z")
                if end <= captured:
                    continue
        result.append(row)
    return result


def properties(root):
    file = root / "server.properties"
    if not file.is_file() or file.stat().st_size > 64_000:
        return {}
    values = {}
    for line in file.read_text(encoding="utf-8", errors="replace").splitlines():
        match = re.fullmatch(r"\s*(white-list|level-name)\s*[=:]\s*(.*?)\s*", line)
        if match:
            values[match[1]] = match[2]
    return values


class Nbt:
    # Read individual fields and skip unrelated tags without deserializing them.
    def __init__(self, data):
        self.data = memoryview(data)
        self.offset = 0

    def take(self, count):
        start = self.offset
        if count < 0 or start + count > len(self.data):
            raise ValueError("Invalid NBT size")
        self.offset += count
        return self.data[start:self.offset]

    def byte(self):
        return self.take(1)[0]

    def integer(self):
        return struct.unpack(">i", self.take(4))[0]

    def string(self):
        return self.take(struct.unpack(">H", self.take(2))[0])

    def fields(self):
        while kind := self.byte():
            yield kind, bytes(self.string())

    def skip(self, kind, depth=0):
        if depth > 64:
            raise ValueError("Unexpected NBT depth")
        if kind in (1, 2, 3, 4, 5, 6):
            self.take((1, 2, 4, 8, 4, 8)[kind - 1])
        elif kind in (7, 11, 12):
            self.take(self.integer() * {7: 1, 11: 4, 12: 8}[kind])
        elif kind == 8:
            self.string()
        elif kind == 9:
            item, count = self.byte(), self.integer()
            if not 0 <= count <= len(self.data) - self.offset or not 0 <= item <= 12 or (item == 0 and count):
                raise ValueError("Invalid NBT list")
            for _ in range(count):
                self.skip(item, depth + 1)
        elif kind == 10:
            for field, _ in self.fields():
                self.skip(field, depth + 1)
        else:
            raise ValueError("Invalid NBT tag")

    def position(self):
        dimension = None
        coordinates = None
        for kind, name in self.fields():
            if name == b"dimension" and kind == 8:
                dimension = dimensions.get(bytes(self.string()))
            elif name == b"pos" and kind == 11:
                count = self.integer()
                values = self.take(4 * count)
                if count == 3:
                    coordinates = struct.unpack(">iii", values)
            else:
                self.skip(kind)
        if dimension and coordinates:
            x, y, z = coordinates
            if abs(x) <= 30_000_000 and abs(z) <= 30_000_000 and abs(y) <= 20_000_000:
                return {"dimension": dimension, "x": x, "y": y, "z": z}
        return None

    def last_death(self):
        if self.byte() != 10:
            raise ValueError("Invalid player NBT root")
        self.string()
        for kind, name in self.fields():
            if kind == 10 and name in (b"LastDeathLocation", b"last_death_location"):
                return self.position()
            self.skip(kind)
        return None


    def item(self):
        slot, item, count = None, None, 1
        for kind, name in self.fields():
            if name == b"Slot" and kind == 1:
                slot = self.byte()
            elif name == b"id" and kind == 8:
                item = bytes(self.string())
            elif name == b"count" and kind == 3:
                count = self.integer()
            elif name == b"Count" and kind == 1:
                count = struct.unpack("b", self.take(1))[0]
            else:
                self.skip(kind)
        if item is None or item == b"minecraft:air" or count <= 0:
            return slot, None
        if len(item) > 160 or not item_id.fullmatch(item):
            raise ValueError("Unexpected item identifier")
        return slot, {"id": item.decode("ascii"), "count": count}

    def inventory(self):
        if self.byte() != 10:
            raise ValueError("Invalid player NBT root")
        self.string()
        carried, worn = None, {}
        for kind, name in self.fields():
            if kind == 9 and name == b"Inventory":
                element, size = self.byte(), self.integer()
                if not 0 <= size <= 41 or (element != 10 and (element != 0 or size)):
                    raise ValueError("Unexpected player inventory")
                carried = {}
                for _ in range(size):
                    slot, value = self.item()
                    if value and (slot in legacy_equipment or (slot is not None and 0 <= slot < 36)):
                        carried[legacy_equipment.get(slot, slot)] = value
            elif kind == 10 and name == b"equipment":
                for entry, key in self.fields():
                    if entry == 10 and key in equipment_slots:
                        _, value = self.item()
                        worn[equipment_slots[key]] = value
                    else:
                        self.skip(entry)
            else:
                self.skip(kind)
        if carried is None:
            return None
        return [{"slot": slot, **value} for slot, value in {**carried, **worn}.items() if value]


def read_player_data(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > nbt_limit:
        raise ValueError("Unexpected player save")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as file:
        opened = os.fstat(file.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
            raise ValueError("Player save changed during open")
        with gzip.GzipFile(fileobj=file) as stream:
            data = stream.read(nbt_limit + 1)
        current = os.fstat(file.fileno())
        if (current.st_size, current.st_mtime_ns, current.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
            raise ValueError("Player save changed during read")
    if len(data) > nbt_limit:
        raise ValueError("Player NBT exceeded size limit")
    return Nbt(data), info.st_mtime_ns // 1_000_000


def saved_deaths(world, uuids):
    directory = world / "playerdata"
    if directory.is_symlink() or directory.parent.is_symlink() or not directory.is_dir():
        return None
    rows = []
    skipped = 0
    for uuid in uuids:
        path = directory / (uuid + ".dat")
        try:
            data, _ = read_player_data(path)
            position = data.last_death()
            if position:
                rows.append({"uuid": uuid, **position})
        except FileNotFoundError:
            continue
        except (OSError, EOFError, ValueError, zlib.error):
            skipped += 1
    return {"rows": rows, "skipped": skipped}


def saved_inventories(world, uuids, captured_at):
    directory = world / "playerdata"
    if directory.is_symlink() or world.is_symlink() or not directory.is_dir():
        raise ValueError("Playerdata directory is unavailable")
    players = []
    for uuid in uuids:
        try:
            data, saved_at = read_player_data(directory / (uuid + ".dat"))
            items = data.inventory()
            if items is not None and 0 <= saved_at <= captured_at:
                players.append({"uuid": uuid, "savedAt": saved_at, "items": items})
        except (OSError, EOFError, ValueError, zlib.error):
            continue
    return {"version": 1, "capturedAt": captured_at, "players": players}


def saved_json(world, folder, uuid):
    directory = world / folder
    if directory.is_symlink() or world.is_symlink():
        raise ValueError("Unexpected profile directory")
    file = directory / (uuid + ".json")
    try:
        if file.is_symlink() or not file.is_file() or file.stat().st_size > nbt_limit:
            if not file.exists() and not file.is_symlink():
                return None
            raise ValueError("Unexpected profile file")
        with file.open("rb") as stream:
            data = stream.read(nbt_limit + 1)
    except FileNotFoundError:
        return None
    if len(data) > nbt_limit:
        raise ValueError("Unexpected profile file size")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("Unexpected profile data")
    return value


def counters(data):
    custom = data.get("stats", {}).get("minecraft:custom", {})
    if "minecraft:play_time" not in custom:
        return None
    result = {target: custom.get(source, 0) for target, source in (
        ("playTicks", "minecraft:play_time"), ("deaths", "minecraft:deaths"), ("mobKills", "minecraft:mob_kills"),
    )}
    if not all(type(value) is int and 0 <= value <= 2**31 - 1 for value in result.values()):
        raise ValueError("Unexpected profile counters")
    return result


def dragon_time(data, captured):
    record = data.get("minecraft:end/kill_dragon", {})
    if record.get("done") is not True:
        return None
    when = datetime.strptime(record.get("criteria", {}).get("killed_dragon", ""), "%Y-%m-%d %H:%M:%S %z")
    if not 0 <= when.timestamp() <= captured.timestamp():
        raise ValueError("Unexpected advancement date")
    return int(when.timestamp() * 1000)


def saved_activity(world, uuids, captured):
    rows = []
    skipped = 0
    for uuid in uuids:
        row = {"uuid": uuid}
        for folder, key, read in (("stats", "stats", counters), ("advancements", "dragonAt", lambda data: dragon_time(data, captured))):
            try:
                data = saved_json(world, folder, uuid)
                value = read(data) if data is not None else None
                if value is not None:
                    row[key] = value
            except (OSError, ValueError, TypeError, AttributeError):
                skipped += 1
        if len(row) > 1:
            rows.append(row)
    return {"rows": rows, "skipped": skipped}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--world")
    parser.add_argument("--inventories", action="store_true")
    args = parser.parse_args()
    if args.inventories and not args.world:
        parser.error("--inventories requires --world")
    root = args.root.resolve(strict=True)
    captured = datetime.now(timezone.utc)
    config = properties(root)
    profiles = {key: entries(root, filename, captured) for key, filename in (
        ("profiles", "usercache.json"), ("whitelist", "whitelist.json"),
        ("operators", "ops.json"), ("banned", "banned-players.json"),
    )}
    output = {
        "capturedAt": int(captured.timestamp() * 1000),
        "whitelistEnabled": {"true": True, "false": False}.get(config.get("white-list")),
        **profiles,
    }
    if args.world:
        if not world_name.fullmatch(args.world) or args.world != config.get("level-name", "world"):
            parser.error("World does not match server.properties")
        world = root / args.world
        uuids = sorted({row["uuid"] for source in profiles.values() if source for row in source})
        if args.inventories:
            print(json.dumps(saved_inventories(world, uuids, output["capturedAt"])))
            return
        output["deaths"] = saved_deaths(world, uuids)
        output["activity"] = saved_activity(world, uuids, captured)
    print(json.dumps(output))


if __name__ == "__main__":
    main()
