import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectFabricMod, makeModStaging, matchesFabricVersion } from './fabric-mod.mjs'
import { makeFileManager } from './file-manager.mjs'
import { makeModLifecycle } from './mod-lifecycle.mjs'
import { zipFixture } from './test-support/zip.mjs'

const modFixture = (metadata, nested = {}) => zipFixture({ 'fabric.mod.json': Buffer.from(JSON.stringify(metadata)), ...nested })

const versions = { minecraft: '1.21.11', fabricloader: '0.19.5', java: '25' }
const sample = { schemaVersion: 1, id: 'sample_mod', version: '1.1.0', depends: { minecraft: ['1.21.10', '1.21.11'], java: '>=21', 'fabric-api': '*' } }

test('sprawdza wersję Minecraft/Fabric/Java i odróżnia brak danych oraz dodatki klienta', async () => {
  const report = await inspectFabricMod(modFixture(sample), versions)
  assert.equal(report.verdict, 'yes')
  assert.deepEqual(report.dependencies, ['fabric-api'])
  assert.equal((await inspectFabricMod(modFixture({ ...sample, environment: 'client' }), versions)).verdict, 'no')
  assert.equal((await inspectFabricMod(modFixture({ ...sample, depends: { minecraft: '1.21.1' } }), versions)).verdict, 'no')
  assert.equal((await inspectFabricMod(modFixture({ ...sample, depends: {} }), versions)).verdict, 'unknown')
  assert.equal(matchesFabricVersion('1.21.x', '1.21.11'), true)
  assert.equal(matchesFabricVersion('>=1.21.9 <1.22', '1.21.11'), true)
  assert.equal(matchesFabricVersion('>=26.1', '1.21.11'), false)
  assert.equal(matchesFabricVersion('^0.19.4', '0.20.0'), true)
  assert.equal(matchesFabricVersion('~0.19.4', '0.20.0'), false)
  assert.equal(matchesFabricVersion('1.21.X-unsupported', '1.21.11'), null)
  await assert.rejects(inspectFabricMod(Buffer.from('tekst, nie ZIP'), versions), { code: 'fabric-metadata' })
})

test('przechowuje JAR poza instancją, deduplikuje zawartość i odrzuca ścieżki', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-mod-stage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = makeModStaging({ directory, versions })
  const jar = modFixture(sample)
  await assert.rejects(store.stage('../outside.jar', jar), { code: 'mod-name' })
  const item = await store.stage('fabric-mod.jar', jar)
  assert.equal(item.digest.length, 64)
  assert.deepEqual(await store.stage('druga-nazwa.jar', jar), item)
  assert.deepEqual(await store.list(), [item])
  await writeFile(join(directory, item.digest + '.jar'), Buffer.alloc(jar.length))
  await assert.rejects(store.read(item.digest), { code: 'mod-staged' })
  await assert.rejects(store.discard('../private'), { code: 'mod-name' })
  await store.discard(item.digest)
  assert.deepEqual(await store.list(), [])
})

test('instaluje, archiwizuje i przywraca ten sam JAR z zachowaniem zależności zagnieżdżonych', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-mod-cycle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'instance')
  const mods = join(root, 'mods')
  await mkdir(mods, { recursive: true })
  const included = 'META-INF/jars/shared.jar'
  const nested = modFixture({ schemaVersion: 1, id: 'dependency', version: '2.0.0', provides: ['shared_api'] })
  await writeFile(join(mods, 'bundle.jar'), modFixture({
    schemaVersion: 1, id: 'bundle', version: '3.0.0', jars: [{ file: included }],
  }, { [included]: nested }))

  let running = true
  const files = makeFileManager({ root, journal: join(directory, 'properties.json'), allowWrites: true, readRunning: () => running })
  const staging = makeModStaging({ directory: join(directory, 'stage'), versions })
  const lifecycle = makeModLifecycle({ files, staging, versions, journal: join(directory, 'journal') })
  const jar = modFixture({ ...sample, depends: { minecraft: '1.21.11', shared_api: '>=2' } })
  const staged = await staging.stage('example.jar', jar)
  const install = { id: randomUUID(), kind: 'install', digest: staged.digest, confirmed: true }
  const markRemoval = async (file) => {
    const info = await lstat(join(mods, file))
    return { id: randomUUID(), kind: 'remove', confirmed: true, file, size: info.size, modifiedAt: info.mtimeMs }
  }
  assert.ok(Number.isFinite((await lifecycle.checkStaged(staged.digest)).checkedAt))
  assert.deepEqual(await readdir(mods), ['bundle.jar'])
  const incompatible = await staging.stage('needs-newer.jar', modFixture({ ...sample, id: 'needs_newer',
    depends: { minecraft: '1.21.11', shared_api: '>=3' } }))
  await assert.rejects(lifecycle.checkStaged(incompatible.digest), { code: 'mod-dependencies', details: ['needs_newer → shared_api'] })
  await writeFile(join(mods, 'blocker.jar'), modFixture({ schemaVersion: 1, id: 'blocker', version: '1', breaks: { sample_mod: '*' } }))
  await assert.rejects(lifecycle.checkStaged(staged.digest), { code: 'mod-dependencies', details: ['blocker × sample_mod'] })
  await rm(join(mods, 'blocker.jar'))
  await assert.rejects(lifecycle.change(install, 'mcc'), { code: 'running' })
  assert.deepEqual(await lifecycle.history(), [])
  running = false
  assert.equal((await lifecycle.change(install, 'mcc')).status, 'applied')
  assert.deepEqual(await readFile(join(mods, 'example.jar')), jar)
  await assert.rejects(lifecycle.checkStaged(staged.digest), { code: 'mod-exists' })
  assert.equal((await lifecycle.change(install, 'mcc')).status, 'applied')
  await assert.rejects(lifecycle.change({ ...install, id: randomUUID() }, 'mcc'), { code: 'mod-exists' })
  await assert.rejects(lifecycle.change(await markRemoval('bundle.jar'), 'mcc'), (error) => {
    assert.equal(error.code, 'mod-dependencies')
    assert.deepEqual(error.details, ['sample_mod → shared_api'])
    return true
  })
  const remove = await markRemoval('example.jar')
  await assert.rejects(lifecycle.change({ ...remove, size: remove.size + 1 }, 'mcc'), { code: 'mod-changed' })
  assert.equal((await lifecycle.change(remove, 'mcc')).status, 'applied')
  await assert.rejects(readFile(join(mods, 'example.jar')), { code: 'ENOENT' })
  assert.deepEqual(await readFile(join(root, '.mcc-removed-mods', remove.id, 'mod.jar')), jar)
  const restore = { id: randomUUID(), kind: 'restore', from: remove.id, confirmed: true }
  const archived = join(root, '.mcc-removed-mods', remove.id, 'mod.jar')
  await writeFile(archived, Buffer.alloc(jar.length))
  await assert.rejects(lifecycle.change(restore, 'mcc'), { code: 'mod-archive' })
  await writeFile(archived, jar)
  assert.equal((await lifecycle.change(restore, 'mcc')).status, 'applied')
  assert.deepEqual(await readFile(join(mods, 'example.jar')), jar)
  assert.equal((await lifecycle.history()).length, 3)
  await assert.rejects(lifecycle.change({ ...restore, id: randomUUID() }, 'mcc'), { code: 'mod-exists' })
})
