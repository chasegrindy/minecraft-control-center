import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeJson } from './json-store.mjs'

const playerName = /^[A-Za-z0-9_]{1,16}$/
const requestId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const weather = new Set(['clear', 'rain', 'thunder'])
const times = new Set(['day', 'noon', 'night', 'midnight'])
const rules = new Set(['keep_inventory', 'advance_time', 'advance_weather', 'spawn_mobs', 'players_sleeping_percentage'])
const moderation = new Set(['kick', 'ban', 'pardon', 'op', 'deop'])
const teleportPattern = /^execute +in +(minecraft:(?:overworld|the_nether|the_end)) +run +teleport +([A-Za-z0-9_]{1,16}) +(-?\d{1,8}) +(-?\d{1,3}) +(-?\d{1,8})$/
const outcomes = new Set(['pending', 'submitted', 'rejected', 'uncertain'])

export function parseGameCommand(raw) {
  if (typeof raw !== 'string' || raw.length > 160 || /[\p{C}\p{Zl}\p{Zp}]/u.test(raw)) return null
  const text = raw.trim().replace(/^\//, '')
  const [kind, first, second, third] = text.split(/ +/)
  if (!first && kind === 'list') return { kind, text, confirm: false }
  if (!first && kind === 'save-all') return { kind, text, confirm: true }
  if (kind === 'say' && first) return { kind, text: 'say ' + text.slice(4).trimStart(), confirm: true }
  if (kind === 'weather' && weather.has(first) && !second) return { kind, text: 'weather ' + first, confirm: true }
  if (kind === 'time' && first === 'set' && times.has(second) && !third) return { kind, text: 'time set ' + second, confirm: true }
  if (kind === 'whitelist' && !second && ['list', 'on', 'off'].includes(first)) {
    return { kind, text: 'whitelist ' + first, confirm: first !== 'list' }
  }
  if (kind === 'whitelist' && ['add', 'remove'].includes(first) && playerName.test(second ?? '') && !third) {
    return { kind, text: 'whitelist ' + first + ' ' + second, confirm: true }
  }
  if (moderation.has(kind) && playerName.test(first ?? '') && !second) {
    return { kind, text: kind + ' ' + first, confirm: true }
  }
  if (kind === 'execute') {
    const target = text.match(teleportPattern)
    if (!target) return null
    const [, dimension, player, ...coordinates] = target
    const [x, y, z] = coordinates.map(Number)
    const [bottom, top] = dimension === 'minecraft:overworld' ? [-64, 319] : [0, 255]
    if (Math.abs(x) >= 30_000_000 || Math.abs(z) >= 30_000_000 || y < bottom || y > top) return null
    return { kind: 'teleport', text: `execute in ${dimension} run teleport ${player} ${x} ${y} ${z}`, confirm: true }
  }
  if (kind !== 'gamerule' || !first || third) return null
  const name = first.replace(/^minecraft:/, '')
  if (!rules.has(name)) return null
  const validValue = name === 'players_sleeping_percentage' ? /^(?:100|[1-9]?[0-9])$/.test(second) : ['true', 'false'].includes(second)
  if (second !== undefined && !validValue) return null
  return { kind, text: 'gamerule minecraft:' + name + (second === undefined ? '' : ' ' + second), confirm: second !== undefined }
}

export function validCommandRequest(input) {
  return typeof input?.id === 'string' && requestId.test(input.id)
}

export async function makeCommandService({ file, send, mode = 'manage', now = Date.now }) {
  if (!['list', 'manage'].includes(mode)) throw new Error('Invalid MCC command mode')
  let entries
  try {
    entries = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    entries = []
  }
  if (!Array.isArray(entries) || entries.length > 100 || entries.some((item) => !validCommandRequest(item)
    || !outcomes.has(item.status) || typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint))) {
    throw new Error('Invalid MCC command journal')
  }
  entries = entries.map((item) => item.status === 'pending' ? { ...item, status: 'uncertain' } : item)
  let busy = false
  let lastSent = -Infinity
  let storageError = false

  async function record(entry) {
    const next = [...entries.filter(({ id }) => id !== entry.id), entry].slice(-100)
    await writeJson(file, next, { durable: true })
    entries = next
  }
  const result = (entry) => ({ status: 200, data: { outcome: entry.status } })

  return {
    mode,
    get enabled() { return !storageError },
    get busy() { return busy },
    async execute(input, actor) {
      const command = validCommandRequest(input) && parseGameCommand(input.command)
      if (!command || (command.confirm && input.confirmed !== true)) return { status: 400, data: { error: 'format' } }
      if (mode === 'list' && command.kind !== 'list') return { status: 403, data: { error: 'mode' } }
      const fingerprint = createHash('sha256').update(command.text).digest('hex')
      const previous = entries.find(({ id }) => id === input.id)
      if (previous) {
        return previous.actor === actor && previous.fingerprint === fingerprint
          ? result(previous) : { status: 409, data: { error: 'conflict' } }
      }
      if (storageError) return { status: 503, data: { error: 'storage' } }
      if (busy || now() - lastSent < 1000) return { status: 429, data: { error: 'busy' } }
      busy = true
      const entry = { id: input.id, actor, kind: command.kind, fingerprint, status: 'pending', requestedAt: now() }
      try {
        await record(entry)
      } catch {
        busy = false
        storageError = true
        return { status: 503, data: { error: 'storage' } }
      }
      let status = 'submitted'
      try {
        lastSent = now()
        await send(command.text)
      } catch (error) {
        status = error.code === 'SERVER_NOT_RUNNING' || [400, 401, 403, 404, 405].includes(error.status) ? 'rejected' : 'uncertain'
      }
      const finished = { ...entry, status, finishedAt: now() }
      try {
        await record(finished)
      } catch {
        storageError = true
        entries = entries.map((item) => item.id === entry.id ? { ...item, status: 'uncertain' } : item)
        return { status: 200, data: { outcome: 'uncertain' } }
      } finally {
        busy = false
      }
      return result(finished)
    },
  }
}
