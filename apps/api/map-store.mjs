import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const dimensions = ['overworld', 'nether', 'end']
const tileRoute = /^\/api\/mcc\/map\/(overworld|nether|end)\/(-?[0-8])\/(-?\d{1,7})\/(-?\d{1,7})$/

async function localFile(root, parts, maxBytes) {
  const file = await realpath(join(root, ...parts))
  const fromRoot = relative(root, file)
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) throw new Error('Path outside snapshot')
  const info = await stat(file)
  if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid snapshot file')
  return readFile(file)
}

export function mapProperties(text, id) {
  const property = (name) => Number(text.match(new RegExp('^\\s*' + name + ': (-?\\d+),?\\s*$', 'm'))?.[1])
  const minZoom = property('minZoom')
  const maxZoom = property('maxZoom')
  const regions = ['minRegionX', 'minRegionZ', 'maxRegionX', 'maxRegionZ'].map(property)
  const [minX, minZ, maxX, maxZ] = regions
  if (!/^\s*imageFormat: "webp",?\s*$/im.test(text) || !Number.isInteger(minZoom) || !Number.isInteger(maxZoom)
    || minZoom < -8 || maxZoom > 4 || minZoom > maxZoom || regions.some((value) => !Number.isInteger(value) || Math.abs(value) > 60_000)
    || minX > maxX || minZ > maxZ) throw new Error('Invalid map metadata')
  const bounds = [minX * 512, minZ * 512, (maxX + 1) * 512, (maxZ + 1) * 512]
  return { id, minZoom, maxZoom, bounds }
}

export function makeMapStore(directory) {
  async function info() {
    try {
      const root = await realpath(directory)
      const snapshot = JSON.parse(await localFile(root, ['snapshot.json'], 4096))
      if (typeof snapshot.date !== 'string' || !Number.isFinite(Date.parse(snapshot.date))) throw new Error('Missing snapshot date')
      const maps = await Promise.all(dimensions.map(async (id) => {
        try {
          const properties = await localFile(root, [id, 'unmined.map.properties.js'], 65_536)
          return mapProperties(properties.toString('utf8'), id)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          return null
        }
      }))
      return { date: snapshot.date, dimensions: maps.filter(Boolean) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { date: null, dimensions: [] }
    }
  }

  async function tile(url) {
    const match = url.match(tileRoute)
    if (!match) return undefined
    const [, id, rawZoom, rawX, rawY] = match
    const [zoom, x, y] = [rawZoom, rawX, rawY].map(Number)
    try {
      const root = await realpath(directory)
      const image = await localFile(root, [id, 'tiles', 'zoom.' + zoom, String(Math.floor(x / 10)), String(Math.floor(y / 10)), 'tile.' + x + '.' + y + '.webp'], 1_048_576)
      if (image.toString('ascii', 0, 4) !== 'RIFF' || image.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Invalid map tile')
      return image
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  }

  return { info, tile }
}
