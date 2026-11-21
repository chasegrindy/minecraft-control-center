import { readFile } from 'node:fs/promises'
import { writeJson } from './json-store.mjs'

const dimensions = new Set(['overworld', 'nether', 'end'])
const categories = new Set(['point', 'base', 'farm'])
const heightLimits = { overworld: [-64, 319], nether: [0, 255], end: [0, 255] }
const maxWaypoints = 100
export const validWaypointId = (id) => typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)
const blockCoordinate = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 30_000_000

export function normalizeWaypoint(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 60 || /[\p{C}\p{Zl}\p{Zp}]/u.test(name) || !validWaypointId(input.id)
    || !categories.has(input.category) || !dimensions.has(input.dimension)
    || !blockCoordinate(input.x) || !blockCoordinate(input.z)) return null
  const waypoint = { id: input.id, name, category: input.category, dimension: input.dimension, x: input.x, z: input.z }
  if (input.hologramY === undefined) return waypoint
  const [min, max] = heightLimits[input.dimension]
  if (!Number.isInteger(input.hologramY) || input.hologramY < min || input.hologramY > max) return null
  return { ...waypoint, hologramY: input.hologramY }
}

export function makeWaypointStore(file, { groupReadable = false } = {}) {
  let pending = Promise.resolve()

  async function read() {
    let value
    try {
      value = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    if (!Array.isArray(value) || value.length > maxWaypoints
      || value.some((item) => !normalizeWaypoint(item) || !Number.isSafeInteger(item.createdAt))
      || new Set(value.map(({ id }) => id)).size !== value.length) {
      throw new Error('Invalid MCC waypoints')
    }
    return value
  }

  function queue(change) {
    const operation = pending.then(async () => change(await read()))
    pending = operation.catch(() => {})
    return operation
  }

  return {
    read,
    create(location) {
      return queue(async (points) => {
        const existing = points.find(({ id }) => id === location.id)
        if (existing) {
          const same = existing.hologramY === location.hologramY &&
            Object.keys(location).every((field) => existing[field] === location[field])
          return { status: same ? 200 : 409, points }
        }
        if (points.length >= maxWaypoints) return { status: 409, points }
        const next = [{ ...location, createdAt: Date.now() }, ...points]
        await writeJson(file, next, { groupReadable })
        return { status: 201, points: next }
      })
    },
    remove(id) {
      return queue(async (points) => {
        const next = points.filter((point) => point.id !== id)
        if (next.length < points.length) await writeJson(file, next, { groupReadable })
        return next
      })
    },
    setHologram(id, y) {
      return queue(async (points) => {
        const index = points.findIndex((point) => point.id === id)
        if (index < 0) return { status: 404, points }
        const point = points[index]
        const hologramY = y === null ? undefined : y
        if (!normalizeWaypoint({ ...point, hologramY })) return { status: 400, points }
        if (point.hologramY === hologramY) return { status: 200, points }
        const next = [...points]
        next[index] = { ...point, hologramY }
        await writeJson(file, next, { groupReadable })
        return { status: 200, points: next }
      })
    },
  }
}
