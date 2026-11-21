import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { makeCraftyArchiveStore } from './crafty-archive.mjs'
import { zipFixture } from './test-support/zip.mjs'

test('weryfikuje katalog ZIP oraz pliki świata i podaje oryginalny strumień', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcc-crafty-zip-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backupId = randomUUID()
  const directory = join(root, backupId)
  const store = makeCraftyArchiveStore({ directory, backupId })
  const name = '2026-11-18_18-59-05.zip'
  assert.equal(await store.accepts(root), true)
  assert.equal(await store.accepts(directory), false)
  assert.equal(await store.inspect(name), null)
  await mkdir(directory)
  const fixture = {
    'server.properties': Buffer.from('level-name=world'),
    'world/level.dat': gzipSync(Buffer.from([10, 0, 0, 0])),
    'world/region/r.0.0.mca': Buffer.alloc(8192),
    'world/DIM-1/region/r.-1.0.mca': Buffer.alloc(8192),
    'world/DIM1/region/r.1.1.mca': Buffer.alloc(8192),
  }
  const valid = zipFixture(fixture)
  const archive = join(directory, name)
  await writeFile(archive, valid.subarray(0, -12))
  assert.equal(await store.inspect(name), null)
  await writeFile(archive, zipFixture({ ...fixture, '../unsafe': Buffer.from('malicious path') }))
  assert.equal(await store.inspect(name), null)
  const { 'world/DIM1/region/r.1.1.mca': removed, ...incomplete } = fixture
  await writeFile(archive, zipFixture(incomplete))
  assert.equal(await store.inspect(name), null)
  await writeFile(archive, valid)
  assert.equal(await store.inspect('../' + name), null)
  assert.equal((await store.inspect(name)).files, 5)
  assert.equal((await store.inspect(name, { full: true })).files, 5)
  const download = await store.download(name)
  assert.deepEqual(await buffer(download.stream), valid)
  assert.deepEqual(await store.usage([name, '2026-11-18_19-00-00.zip', '../' + name]), { bytes: valid.length, count: 1 })
  const corrupted = Buffer.from(valid)
  corrupted[corrupted.indexOf(Buffer.alloc(8192)) + 100] ^= 8
  await writeFile(archive, corrupted)
  assert.equal((await store.inspect(name)).files, 5)
  assert.equal(await store.inspect(name, { full: true }), null)
})
