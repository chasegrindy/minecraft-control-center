import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJson } from './json-store.mjs'

const minute = 60_000
const hour = 60 * minute
const slots = 25
const maxBytes = 8192
const hourOf = (time) => Math.floor(time / hour)
const isMetric = (value) => value === null || (Number.isFinite(value) && value >= 0)

function validSample(sample, bucket) {
  return Number.isSafeInteger(sample?.time) && sample.time >= 0 && sample.time % minute === 0
    && hourOf(sample.time) === bucket && isMetric(sample.cpu) && isMetric(sample.ram)
    && (sample.cpu !== null || sample.ram !== null)
}

export async function openMetricHistory(directory, now = Date.now) {
  const catalog = new Map()
  const pending = new Set()
  const damaged = new Set()
  const filename = (bucket) => join(directory, 'hour-' + bucket % slots + '.json')

  const current = hourOf(now())
  await Promise.all(Array.from({ length: slots }, async (_, offset) => {
    const bucket = current - offset
    if (bucket < 0) return
    try {
      const file = await open(filename(bucket), 'r')
      try {
        if ((await file.stat()).size > maxBytes) throw new Error('Oversized metric history')
        const data = JSON.parse(await file.readFile('utf8'))
        if (!Number.isSafeInteger(data?.hour) || data.hour < 0 || data.hour % slots !== bucket % slots) {
          throw new Error('Invalid metric history hour')
        }
        if (data.hour !== bucket) return
        if (!Array.isArray(data.samples) || data.samples.length > 60 || data.samples.some((sample, index) =>
          !validSample(sample, bucket) || (index > 0 && sample.time <= data.samples[index - 1].time))) {
          throw new Error('Invalid metric history samples')
        }
        catalog.set(bucket, data.samples.map(({ time, cpu, ram }) => ({ time, cpu, ram })))
      } finally {
        await file.close()
      }
    } catch (error) {
      if (error.code !== 'ENOENT') damaged.add(bucket)
    }
  }))

  return {
    // The shared stats poll calls record serially.
    async record(snapshot) {
      const time = Math.floor(snapshot.time / minute) * minute
      const sample = { time, cpu: snapshot.cpu, ram: snapshot.ram }
      const bucket = hourOf(time)
      if (!validSample(sample, bucket)) return
      const samples = catalog.get(bucket) ?? []
      if (samples.length && samples.at(-1).time >= time) return
      for (const old of new Set([...catalog.keys(), ...damaged])) {
        if (old <= bucket - slots || old >= bucket + slots) {
          catalog.delete(old)
          pending.delete(old)
          damaged.delete(old)
        }
      }
      catalog.set(bucket, [...samples, sample])
      pending.add(bucket)
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
      } catch {
        return
      }
      for (const queued of pending) {
        try {
          await writeJson(filename(queued), { hour: queued, samples: catalog.get(queued) })
          pending.delete(queued)
        } catch {
          // Keep the in-memory observations and retry during the next recorded minute.
        }
      }
    },
    read(hours) {
      const at = now()
      const from = at - hours * hour
      const overlaps = (bucket) => bucket >= hourOf(from) && bucket <= hourOf(at)
      const samples = [...catalog].filter(([bucket]) => overlaps(bucket))
        .sort(([left], [right]) => left - right).flatMap(([, values]) => values)
        .filter(({ time }) => time >= from && time <= at)
      return { at, samples, partial: [...pending, ...damaged].some(overlaps) }
    },
  }
}
