import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { makeCraftyArchiveStore } from './crafty-archive.mjs'
import { makeWorldRestore } from './world-restore.mjs'
import { zipFixture } from './test-support/zip.mjs'

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'mcc-world-restore-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'server')
  const active = join(root, 'world')
  const backupId = randomUUID()
  const directory = join(parent, backupId)
  const name = '2026-11-18_18-59-05.zip'
  const properties = 'level-name=world\nmax-players=15\n'
  const region = Buffer.alloc(2 * 1024 * 1024, 0x42)
  region.fill(0x5e, 1024 * 1024)
  const bytes = zipFixture({
    'server.properties': Buffer.from('level-name=world\nmax-players=50\n'),
    'world/level.dat': gzipSync(Buffer.from([10, 0, 0, 0])),
    'world/region/r.0.0.mca': region,
    'world/DIM-1/region/r.-1.0.mca': Buffer.alloc(8192),
    'world/DIM1/region/r.1.1.mca': Buffer.alloc(8192),
  })
  await mkdir(active, { recursive: true })
  await mkdir(directory)
  await writeFile(join(active, 'old-only.dat'), 'previous world')
  await writeFile(join(root, 'server.properties'), properties)
  await writeFile(join(directory, name), bytes)
  const archives = makeCraftyArchiveStore({ directory, backupId })
  const id = randomUUID()
  return { active, id, properties, region, source: await archives.inspect(name),
    options: { root, world: 'world', archives, readRunning: async () => false },
    previous: join(parent, '.mcc-world-recovery-server', id, 'previous'), archive: join(directory, name), bytes }
}

test('podmienia cały świat w istniejącej instancji i zachowuje poprzedni katalog', async (t) => {
  const { active, id, properties, region, source, options, previous } = await fixture(t)
  const world = makeWorldRestore(options)
  assert.deepEqual(await world.replace(id, source), { files: 4 })
  assert.deepEqual(await readFile(join(active, 'region', 'r.0.0.mca')), region)
  assert.equal((await readFile(join(active, 'DIM-1', 'region', 'r.-1.0.mca'))).length, 8192)
  assert.equal((await readFile(join(active, 'DIM1', 'region', 'r.1.1.mca'))).length, 8192)
  await assert.rejects(readFile(join(active, 'old-only.dat')), { code: 'ENOENT' })
  assert.equal(await readFile(join(previous, 'old-only.dat'), 'utf8'), 'previous world')
  assert.equal(await readFile(join(options.root, 'server.properties'), 'utf8'), properties)
  assert.deepEqual(await world.recover(id), { status: 'restored', files: 4 })
})

test('odrzuca uszkodzony region przed przełączeniem katalogu', async (t) => {
  const { active, id, source, options, previous, archive, bytes, region } = await fixture(t)
  const regionOffset = bytes.indexOf(region)
  assert.ok(regionOffset >= 0)
  bytes[regionOffset] ^= 8
  await writeFile(archive, bytes)
  const damaged = await options.archives.inspect(source.name)
  assert.ok(damaged)
  const world = makeWorldRestore(options)
  await assert.rejects(world.replace(id, damaged), { code: 'world-extract' })
  assert.equal(await readFile(join(active, 'old-only.dat'), 'utf8'), 'previous world')
  await assert.rejects(readFile(join(previous, 'old-only.dat')), { code: 'ENOENT' })
})

test('odrzuca błędną grupę przed podmianą świata', async (t) => {
  const { active, id, source, options, previous } = await fixture(t)
  const world = makeWorldRestore({ ...options, groupId: 0xffffffff })
  await assert.rejects(world.replace(id, source), { code: 'world-permissions' })
  assert.equal(await readFile(join(active, 'old-only.dat'), 'utf8'), 'previous world')
  await assert.rejects(stat(previous), { code: 'ENOENT' })
})

test('zachowuje zapis dla wspólnej grupy i prywatny katalog odzyskiwania', {
  skip: process.platform !== 'linux' || !process.getgid?.(),
}, async (t) => {
  const { active, id, source, options, previous } = await fixture(t)
  const groupId = process.getgid()
  await chmod(active, 0o770)
  await makeWorldRestore({ ...options, groupId }).replace(id, source)
  for (const path of [active, join(active, 'DIM-1'), join(active, 'DIM-1', 'region')]) {
    const info = await stat(path)
    assert.equal(info.gid, groupId)
    assert.equal(info.mode & 0o7777, 0o2770)
  }
  const region = await stat(join(active, 'DIM-1', 'region', 'r.-1.0.mca'))
  assert.equal(region.gid, groupId)
  assert.equal(region.mode & 0o777, 0o660)
  assert.equal((await stat(join(previous, '..'))).mode & 0o777, 0o700)
})

test('po awarii podmiany przywraca poprzedni katalog albo kończy odzyskiwanie przy kolejnym sprawdzeniu', async (t) => {
  const { active, id, source, options, previous } = await fixture(t)
  let moveCount = 0
  const interrupted = makeWorldRestore({ ...options, async move(from, to) {
    moveCount++
    if (moveCount >= 2) throw new Error('Simulated failed rename')
    await rename(from, to)
  } })
  await assert.rejects(interrupted.replace(id, source), { code: 'world-recovery' })
  assert.equal(await readFile(join(previous, 'old-only.dat'), 'utf8'), 'previous world')
  await assert.rejects(readFile(join(active, 'old-only.dat')), { code: 'ENOENT' })
  const restarted = makeWorldRestore(options)
  assert.deepEqual(await restarted.recover(id), { status: 'original' })
  assert.equal(await readFile(join(active, 'old-only.dat'), 'utf8'), 'previous world')
  await assert.rejects(readFile(join(previous, 'old-only.dat')), { code: 'ENOENT' })
  assert.deepEqual(await restarted.recover(id), { status: 'original' })
})

test('wstrzymuje podmianę, jeśli gra ruszyła lub serwer ma inny świat', async (t) => {
  const { active, id, source, options } = await fixture(t)
  let stateChecks = 0
  const running = makeWorldRestore({ ...options, readRunning: async () => ++stateChecks > 1 })
  await assert.rejects(running.replace(id, source), { code: 'backup-running' })
  assert.equal(await readFile(join(active, 'old-only.dat'), 'utf8'), 'previous world')
  await writeFile(join(options.root, 'server.properties'), 'level-name=another-world')
  await assert.rejects(makeWorldRestore(options).replace(randomUUID(), source), { code: 'world-name' })
})
