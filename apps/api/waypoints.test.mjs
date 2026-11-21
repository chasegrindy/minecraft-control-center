import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeWaypointStore, normalizeWaypoint } from './waypoints.mjs'

const point = { id: randomUUID(), dimension: 'overworld', category: 'base', name: 'Baza', x: -30, z: 64 }

test('waliduje wymiary i całkowite X/Z w granicach świata', () => {
  assert.deepEqual(normalizeWaypoint({ ...point, name: '  Baza  ' }), point)
  for (const field of [{ id: 'x' }, { dimension: '../nether' }, { category: 'portal' }, { x: '30' },
    { z: 30_000_001 }, { x: 12.5 }, { name: 'Baza\u202e' }, { name: '  ' }]) {
    assert.equal(normalizeWaypoint({ ...point, ...field }), null)
  }
})

test('współbieżne zapisy zachowują oba punkty, a ponowienia nie tworzą duplikatów', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-waypoints-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'waypoints.json')
  const store = makeWaypointStore(file)
  const second = { ...point, id: randomUUID(), name: 'Farma', category: 'farm', dimension: 'nether', hologramY: 0 }
  const writes = await Promise.all([store.create(point), store.create(second)])
  assert.deepEqual(writes.map(({ status }) => status), [201, 201])
  assert.equal((await store.create(point)).status, 200)
  const { hologramY, ...unpublished } = second
  assert.equal(hologramY, 0)
  assert.equal((await store.create(unpublished)).status, 409)
  assert.deepEqual((await makeWaypointStore(file).read())[0].hologramY, 0)
  assert.equal((await store.create({ ...point, name: 'Sporny zapis' })).status, 409)
  assert.deepEqual((await makeWaypointStore(file).read()).map(({ id }) => id), [second.id, point.id])
  await store.remove(point.id)
  assert.deepEqual((await store.remove(point.id)).map(({ id }) => id), [second.id])
})

test('wysokość hologramu jest opcjonalna i ograniczona do wysokości wymiaru', () => {
  assert.deepEqual(normalizeWaypoint({ ...point, hologramY: -64 }), { ...point, hologramY: -64 })
  for (const hologramY of [-65, 320, 12.5, '12', null]) {
    assert.equal(normalizeWaypoint({ ...point, hologramY }), null)
  }
  assert.equal(normalizeWaypoint({ ...point, dimension: 'nether', hologramY: -1 }), null)
  assert.equal(normalizeWaypoint({ ...point, dimension: 'end', hologramY: 256 }), null)
})

test('zmiana hologramu zachowuje punkt, jego datę i pozostałe współrzędne', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-waypoints-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'waypoints.json')
  const store = makeWaypointStore(file)
  const { points: [original] } = await store.create(point)
  assert.equal((await store.setHologram(point.id, 320)).status, 400)
  assert.equal((await store.setHologram(randomUUID(), 65)).status, 404)
  assert.equal((await store.setHologram(point.id, 0)).status, 200)
  assert.deepEqual(await makeWaypointStore(file).read(), [{ ...original, hologramY: 0 }])
  assert.equal((await store.setHologram(point.id, null)).status, 200)
  assert.deepEqual(await makeWaypointStore(file).read(), [original])
})
