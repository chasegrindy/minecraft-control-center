import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, statfs } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { crc32, gunzipSync } from 'node:zlib'
import { unzipRaw } from 'unzipit'
import { isCraftyZip } from './crafty.mjs'
import { child, FileOperationError } from './file-manager.mjs'
import { shareServerFile } from './server-file-access.mjs'

const maxIndexRead = 16 * 1024 * 1024
const maxMetadata = 8 * 1024 * 1024

function safeEntry(entry, seen) {
  const name = entry.name.replace(/\/$/, '')
  const type = (entry.externalFileAttributes >>> 16) & 0o170000
  if (!name || name.includes('\\') || /[\x00-\x1f:]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')
    || seen.has(name) || entry.encrypted || (type && type !== 0o100000 && type !== 0o040000)) return false
  seen.add(name)
  return true
}

async function entriesOf(file) {
  const { entries } = await unzipRaw({
    getLength: async () => file.info.size,
    async read(offset, size) {
      if (offset < 0 || size < 0 || size > maxIndexRead || offset + size > file.info.size) throw new Error('Invalid archive read')
      const bytes = Buffer.alloc(size)
      if ((await file.handle.read(bytes, 0, size, offset)).bytesRead !== size) throw new Error('Incomplete archive')
      return bytes
    },
  })
  const seen = new Set()
  if (!entries.every((entry) => safeEntry(entry, seen))) throw new Error('Unsafe ZIP entries')
  return entries
}

async function unchanged(file) {
  const current = await lstat(file.path)
  return current.dev === file.info.dev && current.ino === file.info.ino && current.size === file.info.size
    && current.mtimeMs === file.info.mtimeMs
}

async function verifyEntry(entry, handle) {
  // The pinned unzipit version stores the central-directory CRC on rawEntry.
  const expectedCrc = entry._rawEntry?.crc32
  if (!Number.isInteger(expectedCrc)) throw new Error('Missing ZIP checksum')
  let crc = 0
  let size = 0
  for await (const bytes of await entry.stream()) {
    size += bytes.byteLength
    if (size > entry.size) throw new Error('Unexpected ZIP entry size')
    crc = crc32(bytes, crc)
    if (handle) await handle.writeFile(bytes)
  }
  if (size !== entry.size || crc !== expectedCrc) throw new Error('The ZIP entry checksum does not match')
}

async function writeWorldFile(entry, path, groupId) {
  const handle = await open(path, 'wx', 0o640)
  try {
    await verifyEntry(entry, handle)
    await shareServerFile(handle, groupId, 0o660)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function makeCraftyArchiveStore({ directory, backupId = null, world = 'world' }) {
  if (!isAbsolute(directory) || (backupId !== null && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(backupId))
    || !/^[A-Za-z0-9_-]{1,64}$/.test(world)) throw new Error('Invalid Crafty archive configuration')

  async function accepts(location) {
    if (!backupId || typeof location !== 'string' || !isAbsolute(location)) return false
    try {
      const parent = await realpath(location)
      const target = join(parent, backupId)
      const canonical = await realpath(target).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!canonical) return relative(resolve(directory), target) === ''
      const local = await realpath(directory)
      const crafty = canonical
      return relative(local, crafty) === ''
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return false
      throw error
    }
  }

  async function checkedFile(name) {
    if (!isCraftyZip(name)) return null
    const root = await realpath(directory).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!root) return null
    const file = await child(root, name, 'file')
    if (!file || file.info.nlink !== 1 || file.info.size < 22) return null
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.dev !== file.info.dev || info.ino !== file.info.ino || info.size !== file.info.size
        || info.mtimeMs !== file.info.mtimeMs) throw new Error('Archive changed while opening')
      return { ...file, handle }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async function usage(names) {
    const root = await realpath(directory).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    let bytes = 0
    let count = 0
    if (root) {
      for (const name of names.filter(isCraftyZip)) {
        const file = await child(root, name, 'file')
        if (!file || file.info.nlink !== 1) continue
        bytes += file.info.size
        count++
      }
    }
    return { bytes, count }
  }

  async function inspect(name, { full = false } = {}) {
    const file = await checkedFile(name)
    if (!file) return null
    try {
      const entries = await entriesOf(file)
      const level = entries.find(({ name }) => name === world + '/level.dat')
      const properties = entries.find(({ name }) => name === 'server.properties')
      if (!level || level.isDirectory || level.size < 18 || level.size > maxMetadata || !properties || properties.isDirectory
        || properties.size < 1 || properties.size > maxMetadata) return null
      for (const dimension of ['region', 'DIM-1/region', 'DIM1/region']) {
        const prefix = world + '/' + dimension + '/'
        if (!entries.some((entry) => entry.name.startsWith(prefix) && /^r\.-?\d+\.-?\d+\.mca$/.test(entry.name.slice(prefix.length))
          && !entry.isDirectory && entry.size >= 8192)) return null
      }
      const nbt = gunzipSync(Buffer.from(await level.arrayBuffer()), { maxOutputLength: maxMetadata })
      if (nbt.length < 4 || nbt[0] !== 10) return null
      const files = entries.filter((entry) => !entry.isDirectory)
      if (full) for (const entry of files) await verifyEntry(entry)
      if (!(await unchanged(file))) return null
      return { name, size: file.info.size, files: files.length, modifiedAt: file.info.mtimeMs }
    } catch {
      return null
    } finally {
      await file.handle.close()
    }
  }

  async function extractWorld(source, target, groupId = null) {
    const file = await checkedFile(source.name)
    if (!file) throw new FileOperationError(409, 'backup-source')
    try {
      if (file.info.size !== source.size || file.info.mtimeMs !== source.modifiedAt) throw new FileOperationError(409, 'backup-source')
      const prefix = world + '/'
      const entries = (await entriesOf(file)).filter(({ name }) => name.startsWith(prefix) && name !== prefix)
      if (!entries.length || !entries.some(({ name, isDirectory }) => !isDirectory && name === prefix + 'level.dat')) {
        throw new FileOperationError(409, 'backup-source')
      }
      const free = await statfs(target, { bigint: true })
      const bytes = entries.reduce((total, entry) => total + BigInt(entry.size), 0n)
      if (free.bavail * free.bsize < bytes) throw new FileOperationError(409, 'world-space')
      const directories = new Set([target])
      for (const entry of entries) {
        const segments = entry.name.slice(prefix.length).replace(/\/$/, '').split('/')
        if (segments.some((segment) => /[<>:"|?*]|[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
          throw new FileOperationError(409, 'backup-source')
        }
        const folders = entry.isDirectory ? segments : segments.slice(0, -1)
        let path = target
        for (const folder of folders) {
          path = join(path, folder)
          if (!directories.has(path)) {
            await mkdir(path, { mode: 0o750 })
            directories.add(path)
          }
        }
        if (!entry.isDirectory) await writeWorldFile(entry, join(path, segments.at(-1)), groupId)
      }
      if (process.platform !== 'win32') {
        for (const path of Array.from(directories).reverse()) {
          const handle = await open(path, 'r')
          try {
            await shareServerFile(handle, groupId, 0o2770)
            await handle.sync()
          } finally {
            await handle.close()
          }
        }
      }
      if (!(await unchanged(file))) throw new FileOperationError(409, 'backup-source')
      return entries.filter(({ isDirectory }) => !isDirectory).length
    } catch (error) {
      if (error instanceof FileOperationError) throw error
      throw new FileOperationError(409, 'world-extract')
    } finally {
      await file.handle.close()
    }
  }

  async function download(name) {
    const archive = await inspect(name)
    if (!archive) return null
    const file = await checkedFile(name)
    if (!file) return null
    if (file.info.size !== archive.size || file.info.mtimeMs !== archive.modifiedAt) {
      await file.handle.close()
      return null
    }
    return { size: archive.size, stream: file.handle.createReadStream() }
  }

  return { accepts, inspect, download, extractWorld, usage }
}
