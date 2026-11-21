import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { makeBackupStore, validArchiveId } from './backup-store.mjs'
import { makeCraftyArchiveStore } from './crafty-archive.mjs'
import { writeJson } from './json-store.mjs'

const execute = promisify(execFile)
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

async function digest(stream) {
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of stream) {
    hash.update(bytes)
    size += bytes.byteLength
  }
  return { size, sha256: hash.digest('hex') }
}

function waitForDecryption(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Odszyfrowanie kopii nie powiodło się.')))
  })
}

async function decodedDigest(age, identity, archive) {
  const child = spawn(age, ['-d', '-i', identity, archive], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const completed = waitForDecryption(child)
  try {
    const [result] = await Promise.all([digest(child.stdout), completed])
    return result
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await completed.catch(() => {})
  }
}

async function decryptToFile(archive, { age, identity, file }) {
  const encrypted = createHash('sha256')
  const checksum = new Transform({ transform(bytes, _encoding, callback) {
    encrypted.update(bytes)
    callback(null, bytes)
  } })
  const child = spawn(age, ['-d', '-i', resolve(identity), '-o', file], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
  const done = waitForDecryption(child)
  try {
    await Promise.all([done, pipeline(archive.stream, checksum, child.stdin)])
    if (encrypted.digest('hex') !== archive.encryptedSha256) throw new Error('Suma SHA-256 zaszyfrowanej kopii jest niezgodna.')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await done.catch(() => {})
  }
}

export async function restoreOffsiteWorld({ id, destination, directory, age, identity, world = 'world' }) {
  if (!validArchiveId(id) || !id.startsWith('crafty-')) throw new Error('Podaj identyfikator kopii ZIP widoczny w katalogu MCC.')
  const requested = resolve(destination)
  const parent = await realpath(dirname(requested))
  const target = join(parent, basename(requested))
  const present = await lstat(target).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (present) throw new Error('Wybierz nowy katalog docelowy.')

  const staging = await mkdtemp(join(parent, '.mcc-offsite-'))
  let reserved = false
  try {
    const restoredArchives = makeCraftyArchiveStore({ directory: staging, world })
    const archive = await makeBackupStore(directory).download(id)
    if (!archive) throw new Error('Brak zweryfikowanej kopii ZIP w katalogu MCC.')
    const name = id.slice('crafty-'.length) + '.zip'
    const file = join(staging, name)
    await decryptToFile(archive, { age, identity, file })
    const decoded = await digest(createReadStream(file, { flags: readFlags }))
    if (decoded.sha256 !== archive.sourceSha256) throw new Error('Suma SHA-256 odszyfrowanego ZIP-a jest niezgodna.')
    const source = await restoredArchives.inspect(name, { full: true })
    if (!source) throw new Error('Odszyfrowany ZIP nie przeszedł weryfikacji danych świata.')
    const prepared = join(staging, 'prepared-world')
    await mkdir(prepared, { mode: 0o700 })
    const files = await restoredArchives.extractWorld(source, prepared)
    await rm(file)
    await mkdir(target, { mode: 0o700 })
    reserved = true
    const worldPath = join(target, world)
    await rename(prepared, worldPath)
    reserved = false
    return { worldPath, files }
  } finally {
    if (reserved) await rmdir(target).catch(() => {})
    await rm(staging, { recursive: true, force: true })
  }
}

export async function importOffsiteBackup({ source, directory, age, identity, world = 'world' }) {
  const file = resolve(source)
  const name = basename(file)
  const id = 'crafty-' + name.slice(0, -4)
  if (!name.endsWith('.zip') || !validArchiveId(id)) throw new Error('Podaj ukończony ZIP o nazwie z Crafty.')
  const destination = join(directory, id)
  const exists = await lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (exists) throw new Error('Kopia o tej dacie jest już w katalogu MCC.')
  const initial = await lstat(file)
  if (!initial.isFile() || initial.nlink !== 1) throw new Error('Kopia źródłowa musi być zwykłym plikiem ZIP.')
  const original = await makeCraftyArchiveStore({ directory: dirname(file), world }).inspect(name, { full: true })
  if (!original || original.size !== initial.size || original.modifiedAt !== initial.mtimeMs) {
    throw new Error('Archiwum Crafty nie przeszło weryfikacji ZIP i świata.')
  }
  const expected = await digest(createReadStream(file, { flags: readFlags }))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(directory, '.incoming-'))
  try {
    const archive = join(staging, 'archive.zip.age')
    try {
      await execute(age, ['-e', '-i', resolve(identity), '-o', archive, file], { windowsHide: true, maxBuffer: 65536 })
    } catch {
      throw new Error('Szyfrowanie age nie powiodło się. Sprawdź program i klucz odzyskiwania.')
    }
    const decoded = await decodedDigest(age, resolve(identity), archive)
    const current = await lstat(file)
    if (current.dev !== initial.dev || current.ino !== initial.ino || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs
      || current.size !== initial.size || expected.size !== initial.size || decoded.size !== expected.size || decoded.sha256 !== expected.sha256) {
      throw new Error('Źródło zmieniło się lub odszyfrowana kopia jest niezgodna.')
    }
    const encrypted = await digest(createReadStream(archive, { flags: readFlags }))
    await chmod(archive, 0o600)
    const handle = await open(archive, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    const metadata = { source: id, sourceDate: name.slice(0, 10), verifiedAt: new Date().toISOString(), size: encrypted.size,
      files: original.files, encryptedSha256: encrypted.sha256, sourceSha256: expected.sha256 }
    await writeJson(join(staging, 'verified.json'), metadata, { durable: true })
    await rename(staging, destination)
    return { id, ...metadata }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
