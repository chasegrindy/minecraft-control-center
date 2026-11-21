import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { test } from 'node:test'
import { makeBackupStore } from './backup-store.mjs'

test('katalog podaje tylko zweryfikowane archiwum, pobieranie odczytuje identyczne bajty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcc-backups-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const id = 'fabric-before-crafty-20261118'
  const bytes = Buffer.from('age-encryption.org/v1\n')
  const archive = join(dir, id + '.tar.age')
  const store = makeBackupStore(dir)
  await writeFile(archive, bytes)
  assert.deepEqual(await store.list(), [])
  const sidecar = {
    source: id, sourceDate: '2026-11-18', verifiedAt: new Date().toISOString(),
    size: bytes.length, files: 1, encryptedSha256: 'a'.repeat(64),
  }
  await writeFile(archive + '.verified.json', JSON.stringify(sidecar))
  assert.deepEqual((await store.list()).map(({ id: key }) => key), [id])
  assert.equal(await store.download('../keys/mcc-age-identity.txt'), null)
  const download = await store.download(id)
  assert.deepEqual(await buffer(download.stream), bytes)
  await writeFile(archive, 'artefakt po zmianie')
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.download(id), null)
})

test('publikuje zweryfikowany zaszyfrowany ZIP i nadaje poprawną nazwę przy pobraniu', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcc-offsite-catalog-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = makeBackupStore(dir)
  const id = 'crafty-2026-11-19_04-08-01'
  const target = join(dir, id)
  const bytes = Buffer.from('age-encryption.org/v1\n')
  await mkdir(target)
  await writeFile(join(target, 'archive.zip.age'), bytes)
  await mkdir(join(dir, '.incoming-tmp'))
  assert.deepEqual(await store.list(), [])
  const metadata = { source: id, sourceDate: '2026-11-19', verifiedAt: new Date().toISOString(), size: bytes.length,
    files: 4, encryptedSha256: 'd'.repeat(64), sourceSha256: 'a'.repeat(64) }
  await writeFile(join(target, 'verified.json'), JSON.stringify(metadata))
  const [record] = await store.list()
  assert.equal(record.format, 'zip.age')
  assert.equal('sourceSha256' in record, false)
  assert.equal(await store.download('../' + id), null)
  const archive = await store.download(id)
  assert.equal(archive.name, id + '.zip.age')
  assert.deepEqual(await buffer(archive.stream), bytes)
})
