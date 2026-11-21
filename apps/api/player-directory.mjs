import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { configPath } from './config.mjs'
import { child } from './file-manager.mjs'
import { configuredWhitelist } from './server-properties.mjs'

export const playerDirectoryPath = join(dirname(configPath), 'player-directory.json')
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const playerName = /^[A-Za-z0-9_]{1,16}$/
const dimensions = new Set(['overworld', 'nether', 'end'])
const empty = { capturedAt: null, whitelistEnabled: null, players: [], bossEvents: [] }
const gameLists = {
  profiles: 'usercache.json', whitelist: 'whitelist.json', operators: 'ops.json', banned: 'banned-players.json',
}

function normalizeDeaths(source, players) {
  if (source == null) return null
  if (!Array.isArray(source.rows) || source.rows.length > players.size || !Number.isInteger(source.skipped)
    || source.skipped < 0 || source.skipped + source.rows.length > players.size) throw new Error('Invalid last death snapshot')
  const seen = new Set()
  const positions = source.rows.map((row) => {
    const player = players.get(row?.uuid)
    const { dimension, x, y, z } = row ?? {}
    if (!player || seen.has(player.uuid) || !dimensions.has(dimension) || ![x, y, z].every(Number.isInteger)
      || Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000 || Math.abs(y) > 20_000_000) throw new Error('Invalid last death position')
    seen.add(player.uuid)
    return { uuid: player.uuid, name: player.name, dimension, x, y, z }
  })
  positions.sort((a, b) => a.name.localeCompare(b.name, 'pl'))
  return { positions, skipped: source.skipped }
}

function normalizeActivity(source, players, capturedAt) {
  if (source == null) return []
  if (!Array.isArray(source.rows) || source.rows.length > players.size || !Number.isInteger(source.skipped)
    || source.skipped < 0 || source.skipped > 2 * players.size) throw new Error('Invalid player activity snapshot')
  const seen = new Set()
  const events = []
  for (const row of source.rows) {
    const profile = players.get(row?.uuid)
    if (!profile || seen.has(profile.uuid) || (row.stats === undefined && row.dragonAt === undefined)) {
      throw new Error('Invalid player activity entry')
    }
    seen.add(profile.uuid)
    if (row.stats !== undefined) {
      const { playTicks, deaths, mobKills } = row.stats ?? {}
      if (![playTicks, deaths, mobKills].every((value) => Number.isInteger(value) && value >= 0 && value <= 2_147_483_647)) {
        throw new Error('Invalid player counters')
      }
      profile.statistics = { playTicks, deaths, mobKills }
    }
    if (row.dragonAt !== undefined) {
      const time = row.dragonAt
      if (!Number.isSafeInteger(time) || time < 0 || time > capturedAt) throw new Error('Invalid dragon advancement timestamp')
      const id = createHash('sha256').update(JSON.stringify(['minecraft:end/kill_dragon', profile.uuid, time])).digest('hex')
      events.push({ id, source: 'minecraft-advancements', type: 'boss', player: profile.name, time, detail: 'Free the End' })
    }
  }
  return events
}

export function normalizeDirectory(snapshot) {
  if (!Number.isSafeInteger(snapshot?.capturedAt) || snapshot.capturedAt < 0 || snapshot.capturedAt > 8_640_000_000_000_000
    || (snapshot.whitelistEnabled !== null && typeof snapshot.whitelistEnabled !== 'boolean')) throw new Error('Invalid player snapshot')
  const players = new Map()
  for (const source of ['profiles', 'whitelist', 'operators', 'banned']) {
    const rows = snapshot[source]
    if (rows === null) continue
    if (!Array.isArray(rows) || rows.length > 2000) throw new Error('Invalid player list')
    for (const row of rows) {
      if (typeof row?.name !== 'string' || !playerName.test(row.name) || typeof row.uuid !== 'string' || !uuid.test(row.uuid)
        || (source === 'operators' && (!Number.isInteger(row.level) || row.level < 0 || row.level > 4))) throw new Error('Invalid player entry')
      const profile = players.get(row.uuid) ?? {
        name: row.name, uuid: row.uuid, whitelisted: snapshot.whitelist === null ? null : false,
        operator: snapshot.operators === null ? null : false, operatorLevel: null, banned: snapshot.banned === null ? null : false,
      }
      if (source === 'whitelist') profile.whitelisted = true
      if (source === 'operators') {
        profile.operator = true
        profile.operatorLevel = row.level
      }
      if (source === 'banned') profile.banned = true
      players.set(row.uuid, profile)
    }
  }
  const bossEvents = normalizeActivity(snapshot.activity, players, snapshot.capturedAt)
  return { capturedAt: snapshot.capturedAt, whitelistEnabled: snapshot.whitelistEnabled, players: [...players.values()],
    lastDeaths: normalizeDeaths(snapshot.deaths, players), bossEvents }
}

async function readSnapshot(path) {
  try {
    return normalizeDirectory(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return empty
    throw error
  }
}

export async function readSavedBossEvents(path = playerDirectoryPath) {
  return (await readSnapshot(path)).bossEvents
}

async function readGameFile(root, name, limit) {
  const file = await child(root, name, 'file')
  if (!file || file.info.nlink !== 1 || file.info.size > limit) throw new Error('Unexpected player file')
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.dev !== file.info.dev || info.ino !== file.info.ino || info.size > limit) {
      throw new Error('Changed player file')
    }
    const bytes = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const current = await handle.stat()
    if (bytesRead !== bytes.length || current.size !== info.size || current.ctimeMs !== info.ctimeMs) {
      throw new Error('Changed player file')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function readGameList(root, source, now) {
  const rows = JSON.parse((await readGameFile(root, gameLists[source], 512_000)).toString('utf8'))
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error('Invalid Minecraft player list')
  return rows.flatMap((row) => {
    if (typeof row?.name !== 'string' || !playerName.test(row.name) || typeof row.uuid !== 'string'
      || !uuid.test(row.uuid.toLowerCase())) throw new Error('Invalid Minecraft player entry')
    if (source === 'operators' && (!Number.isInteger(row.level) || row.level < 0 || row.level > 4)) {
      throw new Error('Invalid Minecraft operator level')
    }
    if (source === 'banned' && row.expires != null && row.expires !== 'forever') {
      const match = typeof row.expires === 'string'
        && row.expires.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/)
      const expires = match ? Date.parse(match[1] + 'T' + match[2] + match[3] + ':' + match[4]) : NaN
      if (!Number.isFinite(expires)) throw new Error('Invalid Minecraft ban expiration')
      if (expires <= now) return []
    }
    return [{ name: row.name, uuid: row.uuid.toLowerCase(), ...(source === 'operators' ? { level: row.level } : {}) }]
  })
}

async function readGameDirectory(root, capturedAt) {
  const path = await realpath(root)
  const [profiles, whitelist, operators, banned, whitelistEnabled] = await Promise.all([
    ...Object.keys(gameLists).map((source) => readGameList(path, source, capturedAt).catch(() => null)),
    readGameFile(path, 'server.properties', 64 * 1024).then(configuredWhitelist).catch(() => null),
  ])
  if ([whitelist, operators, banned, whitelistEnabled].every((value) => value === null)) return null
  return {
    ...normalizeDirectory({ capturedAt, whitelistEnabled, profiles, whitelist, operators, banned }),
    unlisted: { whitelisted: whitelist === null ? null : false, operator: operators === null ? null : false,
      operatorLevel: null, banned: banned === null ? null : false },
  }
}

export function makeLivePlayerSource(root, now = Date.now) {
  if (!root) return null
  if (!isAbsolute(root)) throw new Error('Player folder must be absolute')
  let recent = null
  let until = 0
  let pending
  return () => {
    if (pending) return pending
    const time = now()
    if (time < until) return Promise.resolve(recent)
    pending = readGameDirectory(root, time).catch(() => null).then((value) => {
      recent = value
      until = now() + 2_000
      return value
    }).finally(() => { pending = undefined })
    return pending
  }
}

export async function readPlayerDirectory({ operator, path = playerDirectoryPath, readLive = null }) {
  const source = operator ? readLive : null
  const [{ capturedAt, whitelistEnabled, players, lastDeaths }, live] = await Promise.all([
    readSnapshot(path).catch((error) => {
      if (source) return empty
      throw error
    }),
    source?.(),
  ])
  if (!operator) return { capturedAt, whitelistEnabled: null, players: players.map(({ name, uuid }) => ({ name, uuid })) }
  if (!source) return { capturedAt, whitelistEnabled, players, lastDeaths }
  if (!live) return { capturedAt, whitelistEnabled, players, lastDeaths,
    access: { source: capturedAt === null ? 'unavailable' : 'snapshot', at: capturedAt } }
  const merged = new Map(players.map(({ name, uuid, statistics }) => [
    uuid, { name, uuid, ...live.unlisted, ...(statistics ? { statistics } : {}) },
  ]))
  for (const player of live.players) merged.set(player.uuid, { ...merged.get(player.uuid), ...player })
  return { capturedAt, whitelistEnabled: live.whitelistEnabled, players: [...merged.values()], lastDeaths,
    access: { source: 'live', at: live.capturedAt } }
}
