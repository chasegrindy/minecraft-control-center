import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

const fileLimit = 256 * 1024
const rowLimit = 1024
const eventLimit = 300
const dimensions = new Set(['overworld', 'nether', 'end'])
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const player = /^[A-Za-z0-9_]{1,16}$/
const coordinate = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 30_000_000

export function normalizeFabricEvent(input, now = Date.now()) {
  if (input?.v !== 1 || typeof input.id !== 'string' || !uuid.test(input.id)
    || typeof input.uuid !== 'string' || !uuid.test(input.uuid) || typeof input.player !== 'string' || !player.test(input.player)
    || !Number.isSafeInteger(input.time) || input.time < 0 || input.time > now + 60_000) return null
  const { dimension, x, y, z } = input.location ?? {}
  if (!dimensions.has(dimension) || ![x, y, z].every(coordinate)) return null
  const event = { id: 'fabric-' + input.id, source: 'fabric', type: input.type, time: input.time,
    player: input.player, uuid: input.uuid, location: { dimension, x, y, z }, detail: null }
  if (input.type === 'death') return event
  if (input.type === 'dimension' && dimensions.has(input.fromDimension) && input.fromDimension !== dimension) {
    return { ...event, fromDimension: input.fromDimension, toDimension: dimension }
  }
  if (input.type === 'boss' && input.boss === 'wither') return { ...event, boss: input.boss }
  return null
}

function parseJournal(buffer, now) {
  const text = buffer.toString('utf8')
  const lastLine = text.lastIndexOf('\n')
  if (lastLine < 0) return { events: [], skipped: 0 }
  const events = []
  let skipped = 0
  for (const line of text.slice(0, lastLine).split('\n')) {
    if (!line.length) continue
    const value = line.length <= rowLimit ? parseRow(line, now) : null
    if (value) events.push(value)
    else skipped++
  }
  return { events, skipped }
}

function parseRow(line, now) {
  try { return normalizeFabricEvent(JSON.parse(line), now) } catch { return null }
}

function latestDeaths(events) {
  const deaths = new Map()
  for (const event of events) {
    if (event.type !== 'death' || deaths.has(event.uuid)) continue
    deaths.set(event.uuid, { uuid: event.uuid, name: event.player, time: event.time, ...event.location })
    if (deaths.size === eventLimit) break
  }
  return [...deaths.values()]
}

export function makeFabricEventSource(directory, now = Date.now) {
  if (!directory) return null
  if (!isAbsolute(directory)) throw new Error('MCC world-event directory must be absolute')
  const root = resolve(directory)
  const cache = new Map()
  let combined

  async function readJournal(filename) {
    const path = join(root, filename)
    let info
    try { info = await lstat(path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      cache.delete(filename)
      return null
    }
    if (!info.isFile() || info.size > fileLimit) throw new Error('Invalid MCC world-event journal')
    const stamp = [info.dev, info.ino, info.size, info.mtimeMs].join('/')
    const cached = cache.get(filename)
    if (cached?.stamp === stamp) return cached
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await file.stat()
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('World-event journal changed during opening')
      const buffer = Buffer.alloc(info.size)
      let read = 0
      while (read < buffer.length) {
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, read)
        if (!bytesRead) break
        read += bytesRead
      }
      const entry = { stamp, ...parseJournal(buffer.subarray(0, read), now()) }
      cache.set(filename, entry)
      return entry
    } finally {
      await file.close()
    }
  }

  async function readFabricEvents() {
    let actual
    try { actual = await realpath(root) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { status: 'waiting', events: [], deaths: [], skipped: 0 }
    }
    if (relative(root, actual) !== '') throw new Error('World-event journal directory resolves outside its configured path')
    let unavailable = false
    const safeRead = (filename) => readJournal(filename).catch(() => {
      unavailable = true
      return cache.get(filename) ?? null
    })
    const current = await safeRead('events.jsonl')
    const previous = await safeRead('events.previous.jsonl')
    if (combined && combined.current === current && combined.previous === previous && combined.unavailable === unavailable) {
      return combined.result
    }
    const events = new Map()
    for (const event of [...(previous?.events ?? []), ...(current?.events ?? [])]) events.set(event.id, event)
    const skipped = (current?.skipped ?? 0) + (previous?.skipped ?? 0)
    const ordered = [...events.values()].sort((a, b) => b.time - a.time)
    const result = { status: unavailable ? 'error' : current || previous ? 'ok' : 'waiting',
      events: ordered.slice(0, eventLimit), deaths: latestDeaths(ordered), skipped }
    combined = { current, previous, unavailable, result }
    return result
  }

  let pending
  return () => {
    pending ??= readFabricEvents().finally(() => { pending = null })
    return pending
  }
}
