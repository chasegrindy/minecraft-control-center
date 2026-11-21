import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configPath } from './config.mjs'

export const playerInventoryPath = join(dirname(configPath), 'player-inventories.json')
export const maxInventoryBytes = 20_000_000
export const playerUuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const itemId = /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/
const equipmentSlots = new Set(['head', 'chest', 'legs', 'feet', 'offhand'])

function validSlot(slot) {
  return equipmentSlots.has(slot) || (Number.isInteger(slot) && slot >= 0 && slot < 36)
}

export function normalizeInventories(source) {
  const { version, capturedAt, players } = source ?? {}
  if (version !== 1 || !Number.isSafeInteger(capturedAt) || capturedAt < 0 || capturedAt > 8_640_000_000_000_000
    || !Array.isArray(players) || players.length > 2000) throw new Error('Invalid inventory snapshot')
  const seenPlayers = new Set()
  const rows = players.map(({ uuid, savedAt, items } = {}) => {
    if (typeof uuid !== 'string' || !playerUuid.test(uuid) || seenPlayers.has(uuid)
      || !Number.isSafeInteger(savedAt) || savedAt < 0 || savedAt > capturedAt
      || !Array.isArray(items) || items.length > 41) throw new Error('Invalid saved inventory')
    seenPlayers.add(uuid)
    const seenSlots = new Set()
    const normalized = items.map(({ slot, id, count } = {}) => {
      if (!validSlot(slot) || seenSlots.has(slot) || typeof id !== 'string' || id.length > 160 || !itemId.test(id)
        || id === 'minecraft:air' || !Number.isInteger(count) || count < 1 || count > 2_147_483_647) {
        throw new Error('Invalid inventory item')
      }
      seenSlots.add(slot)
      return { slot, id, count }
    })
    return { uuid, savedAt, items: normalized }
  })
  return { version, capturedAt, players: rows }
}

export function makePlayerInventoryStore(path = playerInventoryPath) {
  let previous
  let pending

  async function readSnapshot() {
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      previous = undefined
      return null
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > maxInventoryBytes) throw new Error('Unexpected inventory file')
      const key = [info.dev, info.ino, info.size, info.ctimeMs, info.mtimeMs].join(':')
      if (previous?.key === key) return previous.players
      const bytes = Buffer.alloc(info.size)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const current = await handle.stat()
      if (bytesRead !== bytes.length || current.size !== info.size || current.mtimeMs !== info.mtimeMs
        || current.ctimeMs !== info.ctimeMs) throw new Error('Inventory file changed during read')
      const snapshot = normalizeInventories(JSON.parse(bytes.toString('utf8')))
      const players = new Map(snapshot.players.map((row) => [row.uuid, row]))
      previous = { key, players }
      return players
    } finally {
      await handle.close()
    }
  }

  return async (uuid) => {
    if (!playerUuid.test(uuid)) return null
    pending ??= readSnapshot().finally(() => { pending = undefined })
    return (await pending)?.get(uuid) ?? null
  }
}
