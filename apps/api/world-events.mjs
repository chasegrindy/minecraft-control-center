import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configPath } from './config.mjs'
import { writeJson } from './json-store.mjs'

const day = 86_400_000
const maxEvents = 300
const playerPattern = /^[A-Za-z0-9_]{1,16}$/
const types = new Set(['join', 'leave', 'advancement', 'death'])
const logLine = /^\[([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\] \[Server thread\/INFO\]: ([A-Za-z0-9_]{1,16}) (.+)$/
const advancement = /^has (?:made the advancement|completed the challenge|reached the goal) \[([^\r\n]{1,180})\]$/
const death = /^(?:drowned|starved to death|fell from a high place|hit the ground too hard|went up in flames|burned to death|tried to swim in lava|blew up|was blown up by .{1,150}|was slain by .{1,150}|was shot by .{1,150}|fell out of the world|died)(?: whilst .{1,100})?$/

export function parseServerEvent(line, utcDay, earliest = -Infinity, latest = Infinity) {
  const match = typeof line === 'string' && line.match(logLine)
  if (!match) return null
  const [, hours, minutes, seconds, player, text] = match
  let time = utcDay + (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000
  if (time > latest) time -= day
  if (time < earliest) return null

  const achievement = text.match(advancement)
  let type
  let detail = null
  if (text === 'joined the game') type = 'join'
  else if (text === 'left the game') type = 'leave'
  else if (achievement) {
    type = 'advancement'
    detail = achievement[1]
  } else if (death.test(text)) {
    type = 'death'
    detail = text.slice(0, 180)
  } else return null

  const id = createHash('sha256').update(JSON.stringify([time, type, player, detail])).digest('hex')
  return { id, source: 'minecraft-log', time, type, player, detail }
}

export function observedEvents(previous, lines, lastRead, now) {
  if (!previous || now - lastRead > day / 2) return []
  let overlap = Math.min(previous.length, lines.length)
  while (overlap && !lines.slice(0, overlap).every((line, index) => line === previous[previous.length - overlap + index])) {
    overlap--
  }
  const utcDay = Math.floor(now / day) * day
  return lines.slice(overlap).map((line) => parseServerEvent(line, utcDay, lastRead - 2000, now + 5000)).filter(Boolean)
}

export function mergeWorldActivity(logs, bosses, fabric = []) {
  const saved = [...bosses].sort((a, b) => b.time - a.time).slice(0, maxEvents)
  const deaths = fabric.filter(({ type }) => type === 'death')
  const matchedDeaths = new Map()
  const distinct = logs.filter((event) => {
    if (event.type === 'advancement' && event.detail === 'Free the End') {
      return !saved.some((boss) => boss.player === event.player && Math.abs(boss.time - event.time) <= 1000)
    }
    if (event.type !== 'death') return true
    const match = deaths.find((death) => !matchedDeaths.has(death.id) && death.player === event.player
      && Math.abs(death.time - event.time) <= 1500)
    if (!match) return true
    matchedDeaths.set(match.id, event.detail)
    return false
  })
  const precise = fabric.map((event) => matchedDeaths.has(event.id) ? { ...event, detail: matchedDeaths.get(event.id) } : event)
  return [...distinct, ...saved, ...precise].sort((a, b) => b.time - a.time)
}

function validEvent(event) {
  return typeof event?.id === 'string' && /^[a-f0-9]{64}$/.test(event.id)
    && event.source === 'minecraft-log' && Number.isSafeInteger(event.time)
    && event.time >= 0 && event.time < 8_640_000_000_000_000 && types.has(event.type)
    && typeof event.player === 'string' && playerPattern.test(event.player)
    && (event.detail === null || (typeof event.detail === 'string' && event.detail.length <= 180))
}

function logEventFields({ id, source, time, type, player, detail }) {
  return { id, source, time, type, player, detail }
}

export function normalizeLogEvents(events) {
  if (!Array.isArray(events) || events.length > maxEvents || events.some((event) => !validEvent(event))) {
    throw new Error('Invalid MCC world events')
  }
  return events.map(logEventFields)
}

export function makeEventStore(file = join(dirname(configPath), 'world-events.json')) {
  async function read() {
    try {
      return normalizeLogEvents(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return []
    }
  }

  return {
    read,
    async append(events) {
      const previous = await read()
      const combined = new Map(previous.map((event) => [event.id, event]))
      for (const event of events) {
        if (validEvent(event)) combined.set(event.id, logEventFields(event))
      }
      const next = [...combined.values()].sort((a, b) => b.time - a.time).slice(0, maxEvents)
      if (next.some((event, index) => event.id !== previous[index]?.id)) await writeJson(file, next)
      return next
    },
  }
}
