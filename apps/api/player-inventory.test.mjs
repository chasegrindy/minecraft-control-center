import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeJson } from './json-store.mjs'
import { makePlayerInventoryStore, normalizeInventories } from './player-inventory.mjs'

const uuid = '7c3478de-7556-41e5-855a-2d2a416d0bb9'
const other = 'bc3478de-7556-41e5-855a-2d2a416d0bb9'
const held = { slot: 0, id: 'minecraft:bread', count: 8 }
const armor = { slot: 'head', id: 'minecraft:iron_helmet', count: 1 }
const player = { uuid, savedAt: 99, items: [held, armor] }
const snapshot = { version: 1, capturedAt: 100, players: [player] }

test('przyjmuje zwykłe sloty i noszony ekwipunek oraz pomija dodatkowe pola', () => {
  const input = { ...snapshot, players: [{ ...player, items: [{ ...held, components: { private: true } }, armor] }] }
  assert.deepEqual(normalizeInventories(input), snapshot)
  for (const item of [{ slot: 36 }, { slot: 'ender_chest' }, { id: '../secret' }, { count: -1 }, { id: 'minecraft:air' }]) {
    assert.throws(() => normalizeInventories({ ...snapshot, players: [{ ...player, items: [{ ...held, ...item }] }] }), /Invalid inventory item/)
  }
  assert.throws(() => normalizeInventories({ ...snapshot, players: [{ ...player, savedAt: 101 }] }), /Invalid saved inventory/)
  assert.throws(() => normalizeInventories({ ...snapshot, players: [player, player] }), /Invalid saved inventory/)
  assert.throws(() => normalizeInventories({ ...snapshot, players: [{ ...player, items: [held, held] }] }), /Invalid inventory item/)
})

test('zwraca tylko wskazane UUID i rozróżnia pusty zapis, brak oraz nową migawkę', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcc-inventory-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'inventory.json')
  const read = makePlayerInventoryStore(file)
  assert.equal(await read(uuid), null)
  await writeJson(file, snapshot)
  assert.deepEqual(await Promise.all([read(uuid), read(other), read('../outside')]), [player, null, null])
  const empty = { uuid, savedAt: 103, items: [] }
  await writeJson(file, { ...snapshot, capturedAt: 104, players: [empty] })
  assert.deepEqual(await read(uuid), empty)
  await rm(file)
  assert.equal(await read(uuid), null)
})
