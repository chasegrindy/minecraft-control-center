import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeFabricEventSource, normalizeFabricEvent } from './fabric-events.mjs'
import { mergeWorldActivity, parseServerEvent } from './world-events.mjs'

const now = Date.parse('2026-11-18T13:21:51Z')
const base = { v: 1, id: randomUUID(), uuid: randomUUID(), time: now - 100, player: 'MccTester',
  type: 'death', location: { dimension: 'nether', x: 42, y: 120, z: -17 } }
const encode = (value) => JSON.stringify(value) + '\n'

test('dziennik Fabric zachowuje pełne wiersze, rotację i dokładne współrzędne', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-fabric-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const current = join(directory, 'events.jsonl')
  const previous = join(directory, 'events.previous.jsonl')
  const source = makeFabricEventSource(directory, () => now)
  assert.equal((await source()).status, 'waiting')

  const travel = { ...base, id: randomUUID(), type: 'dimension', fromDimension: 'overworld', time: now - 650 }
  await writeFile(current, encode(travel) + JSON.stringify(base))
  const first = await source()
  assert.equal(first.status, 'ok')
  assert.deepEqual(first.events, [normalizeFabricEvent(travel, now)])
  assert.deepEqual(first, await source())
  await appendFile(current, '\n')
  assert.deepEqual((await source()).events.map(({ type }) => type), ['death', 'dimension'])
  await rename(current, previous)
  await writeFile(current, encode(base) + encode({ ...base, id: randomUUID(), location: { ...base.location, x: 99_000_000 } }))
  const rotated = await source()
  assert.deepEqual(rotated.events[0].location, { dimension: 'nether', x: 42, y: 120, z: -17 })
  assert.equal(rotated.events.length, 2)
  assert.equal(rotated.skipped, 1)

  await writeFile(previous, Buffer.alloc(256 * 1024 + 1))
  assert.equal((await source()).status, 'error')
  assert.deepEqual((await source()).events.map(({ type }) => type), ['death', 'dimension'])
  assert.throws(() => makeFabricEventSource('relative/events'))
})

test('oś czasu łączy współrzędne śmierci Fabric z komunikatem Minecrafta', () => {
  const midnight = Date.parse('2026-11-18T00:00:00Z')
  const same = parseServerEvent('[13:21:50] [Server thread/INFO]: MccTester was slain by Zombie', midnight)
  const other = parseServerEvent('[13:21:48] [Server thread/INFO]: MccTester drowned', midnight)
  const precise = normalizeFabricEvent(base, now)
  assert.deepEqual(mergeWorldActivity([same, other], [], [precise]), [{ ...precise, detail: 'was slain by Zombie' }, other])
  for (const sample of [{ ...base, player: 'name with spaces' }, { ...base, time: now + 61_000 },
    { ...base, type: 'dimension', fromDimension: 'nether' }, { ...base, type: 'boss', boss: 'unknown' }]) {
    assert.equal(normalizeFabricEvent(sample, now), null)
  }
})

test('mapa zachowuje ostatnią śmierć każdego UUID także poza limitem osi czasu', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-fabric-death-map-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const anotherPlayer = { ...base, id: randomUUID(), uuid: randomUUID(), time: now - 9000 }
  const firstDeath = { ...base, time: now - 8000 }
  const lastDeath = { ...base, id: randomUUID(), time: now - 7000, location: { ...base.location, x: -28 } }
  const recentTravel = Array.from({ length: 301 }, (_, index) => ({
    ...base, id: randomUUID(), time: now - index - 500, type: 'dimension', fromDimension: 'overworld',
  }))
  await writeFile(join(directory, 'events.jsonl'), [anotherPlayer, firstDeath, lastDeath, ...recentTravel].map(encode).join(''))
  const read = makeFabricEventSource(directory, () => now)
  const [summary, concurrent] = await Promise.all([read(), read()])
  assert.strictEqual(summary, concurrent)
  assert.equal(summary.events.length, 300)
  assert.equal(summary.events.some((event) => event.type === 'death'), false)
  assert.deepEqual(summary.deaths, [lastDeath, anotherPlayer].map(({ uuid, player, time, location }) =>
    ({ uuid, name: player, time, ...location })))
})
