import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { makeMapStore } from '../api/map-store.mjs'
import { normalizeDirectory } from '../api/player-directory.mjs'
import { makeWaypointStore, normalizeWaypoint } from '../api/waypoints.mjs'
import { normalizeLogEvents } from '../api/world-events.mjs'

const exec = promisify(execFile)
const [id, sourceDirectory, outputDirectory, eventOption, ...extra] = process.argv.slice(2)
if (extra.length || (eventOption !== undefined && eventOption !== '--include-events') || !/^[a-z0-9][a-z0-9.-]{0,47}$/.test(id ?? '')
  || !sourceDirectory || !isAbsolute(sourceDirectory) || !outputDirectory || !isAbsolute(outputDirectory)) {
  throw new Error('Użyj node apps/ops/package-view-data.mjs <id> <pełna ścieżka stanu MCC> <pełna ścieżka wyjścia> [--include-events]')
}

const source = await realpath(sourceDirectory)
await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
const output = await realpath(outputDirectory)
const files = ['map-work', 'player-directory.json', 'world-waypoints.json']
const eventsFile = 'world-events.json'
const name = 'mcc-view-data-' + id
const archiveName = name + '.tar.gz'
const target = join(output, name)
const info = await lstat(target).catch((error) => {
  if (error.code !== 'ENOENT') throw error
  return null
})
if (info) throw new Error('Paczka danych o tym identyfikatorze już istnieje.')

const mapFolder = 'map-work/published'
const sourceMap = join(source, mapFolder)
if (await realpath(sourceMap) !== sourceMap) throw new Error('Mapa musi znajdować się w katalogu stanu MCC.')
const maps = makeMapStore(sourceMap)
const snapshot = await maps.info()
if (!snapshot.date || snapshot.dimensions.length !== 3) throw new Error('Brakuje aktualnej migawki mapy lub wymiaru.')

function selectFields(input, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]))
}

async function sourceFile(name, limit) {
  const path = join(source, name)
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1 || info.size > limit || await realpath(path) !== path) {
    throw new Error('Nieprawidłowy plik podglądu ' + name)
  }
  return JSON.parse(await readFile(path, 'utf8'))
}

function playerSnapshot(input) {
  normalizeDirectory(input)
  const { capturedAt, whitelistEnabled, profiles, whitelist, operators, banned, deaths, activity } = input
  const identity = (rows) => rows?.map((row) => selectFields(row, ['name', 'uuid'])) ?? null
  return {
    capturedAt, whitelistEnabled, profiles: identity(profiles), whitelist: identity(whitelist), banned: identity(banned),
    operators: operators?.map((row) => selectFields(row, ['name', 'uuid', 'level'])) ?? null,
    ...(deaths ? { deaths: { skipped: deaths.skipped,
      rows: deaths.rows.map((row) => selectFields(row, ['uuid', 'dimension', 'x', 'y', 'z'])) } } : {}),
    ...(activity ? { activity: { skipped: activity.skipped, rows: activity.rows.map((row) => ({
      ...selectFields(row, ['uuid', 'dragonAt']),
      ...(row.stats ? { stats: selectFields(row.stats, ['playTicks', 'deaths', 'mobKills']) } : {}),
    })) } } : {}),
  }
}

function dimensionProperties({ minZoom, maxZoom, bounds }) {
  const [minRegionX, minRegionZ, maxX, maxZ] = bounds.map((coordinate) => coordinate / 512)
  return [
    'var UnminedMapProperties = {', '    minZoom: ' + minZoom + ',', '    maxZoom: ' + maxZoom + ',',
    '    minRegionX: ' + minRegionX + ',', '    minRegionZ: ' + minRegionZ + ',',
    '    maxRegionX: ' + (maxX - 1) + ',', '    maxRegionZ: ' + (maxZ - 1) + ',',
    '    imageFormat: "webp",', '}', '',
  ].join('\n')
}

async function copyDimension(map, directory) {
  const sourceTiles = join(sourceMap, map.id, 'tiles')
  if (await realpath(sourceTiles) !== sourceTiles) throw new Error('Katalog kafli wymiaru jest przekierowany.')
  const destination = join(directory, map.id)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  await writeFile(join(destination, 'unmined.map.properties.js'), dimensionProperties(map), { mode: 0o600 })

  let count = 0
  const entries = await readdir(sourceTiles, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    const tile = /^tile\.(-?\d{1,7})\.(-?\d{1,7})\.webp$/.exec(entry.name)
    if (!tile) continue
    if (!entry.isFile()) throw new Error('Kafel mapy musi być zwykłym plikiem.')
    const [zoomDirectory, xBucket, zBucket, ...rest] = relative(sourceTiles, entry.parentPath).split(sep)
    const zoomMatch = /^zoom\.(-?[0-8])$/.exec(zoomDirectory)
    const zoom = Number(zoomMatch?.[1])
    const [x, z] = tile.slice(1).map(Number)
    if (!zoomMatch || zoom < map.minZoom || zoom > map.maxZoom || rest.length
      || xBucket !== String(Math.floor(x / 10)) || zBucket !== String(Math.floor(z / 10))
      || entry.name !== `tile.${x}.${z}.webp`) throw new Error('Nieprawidłowe położenie kafla mapy.')
    const bytes = await maps.tile(`/api/mcc/map/${map.id}/${zoom}/${x}/${z}`)
    if (!bytes) throw new Error('Kafel zniknął podczas przygotowywania paczki.')
    const folder = join(destination, 'tiles', zoomDirectory, xBucket, zBucket)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(join(folder, entry.name), bytes, { flag: 'wx', mode: 0o600 })
    count++
  }
  if (!count) throw new Error('Brakuje kafli wymiaru ' + map.id)
  return count
}

const playerData = playerSnapshot(await sourceFile('player-directory.json', 2_000_000))
const waypoints = await sourceFile('world-waypoints.json', 100_000).then((rows) =>
  rows.map((row) => ({ ...normalizeWaypoint(row), createdAt: row.createdAt }))).catch((error) => {
  if (error.code === 'ENOENT') return []
  throw error
})
const events = eventOption ? normalizeLogEvents(await sourceFile(eventsFile, 256 * 1024)) : null
const temporary = await realpath(await mkdtemp(join(output, '.view-data-')))
try {
  const payload = join(temporary, 'payload')
  const sealed = join(temporary, 'bundle')
  const destinationMap = join(payload, mapFolder)
  await mkdir(destinationMap, { recursive: true, mode: 0o700 })
  await mkdir(sealed, { mode: 0o700 })
  const write = (folder, file, value) => writeFile(join(folder, file), JSON.stringify(value) + '\n', { mode: 0o600 })
  await write(destinationMap, 'snapshot.json', { date: snapshot.date })
  await write(payload, 'player-directory.json', playerData)
  await write(payload, 'world-waypoints.json', waypoints)
  await makeWaypointStore(join(payload, 'world-waypoints.json')).read()
  if (events) {
    await write(payload, eventsFile, events)
    files.push(eventsFile)
  }
  let tiles = 0
  for (const map of snapshot.dimensions) tiles += await copyDimension(map, destinationMap)
  if (JSON.stringify(await maps.info()) !== JSON.stringify(snapshot)) throw new Error('Mapa zmieniła się podczas pakowania.')
  const archive = join(sealed, archiveName)
  await exec('tar', ['-czf', archive, '-C', payload, ...files])
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  await writeFile(join(sealed, archiveName + '.sha256'), hash.digest('hex') + '  ' + archiveName + '\n', { mode: 0o600 })
  await rename(sealed, target)
  console.log(`Mapa z ${snapshot.date}. Liczba kafli w trzech wymiarach to ${tiles}.`)
  console.log(join(target, archiveName))
} finally {
  if (dirname(await realpath(temporary)) !== output) throw new Error('Katalog roboczy jest poza katalogiem wyjścia.')
  await rm(temporary, { recursive: true, force: true })
}
