import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeMapStore } from './map-store.mjs'

test('wczytuje wymiary i ujemne indeksy terenu, odrzuca ścieżki do innych plików', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcc-map-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = makeMapStore(dir)
  assert.deepEqual(await store.info(), { date: null, dimensions: [] })

  const date = '2026-11-18'
  const tiles = join(dir, 'overworld', 'tiles', 'zoom.-2', '-1', '-2')
  await mkdir(tiles, { recursive: true })
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ date }))
  await writeFile(join(dir, 'overworld', 'unmined.map.properties.js'), `
var UnminedMapProperties = {
    minZoom: -6,
    maxZoom: 0,
    minRegionX: -2,
    minRegionZ: -4,
    maxRegionX: 1,
    maxRegionZ: 2,
    imageFormat: "webp",
}
`)
  const header = Buffer.from('RIFF0000WEBP')
  await writeFile(join(tiles, 'tile.-1.-11.webp'), header)
  assert.deepEqual(await store.info(), {
    date, dimensions: [{ id: 'overworld', minZoom: -6, maxZoom: 0, bounds: [-1024, -2048, 1024, 1536] }],
  })
  assert.deepEqual(await store.tile('/api/mcc/map/overworld/-2/-1/-11'), header)
  assert.equal(await store.tile('/api/mcc/map/overworld/-2/-1/-12'), null)
  assert.equal(await store.tile('/api/mcc/map/overworld/../../snapshot.json'), undefined)
  assert.equal(await store.tile('/api/mcc/map/nether/0/%2e%2e/0'), undefined)
})
