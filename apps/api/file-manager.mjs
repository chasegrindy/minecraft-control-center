import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { writeJson } from './json-store.mjs'
import { applyProperties, configuredWorld, inspectProperties, propertyFields, validPropertyChanges } from './server-properties.mjs'
import { canShareServerFile, shareServerFile } from './server-file-access.mjs'

const revisionPattern = /^[a-f0-9]{64}$/
export const operationId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const safeFilename = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,159}$/
const directories = ['world', 'mods', 'config', 'logs']
const knownFiles = ['server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'usercache.json', 'eula.txt']
const maxProperties = 64 * 1024

export class FileOperationError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

export async function child(parent, name, kind) {
  try {
    const target = join(parent, name)
    const info = await lstat(target)
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) return null
    const path = await realpath(target)
    if (dirname(path) !== parent) return null
    return { path, info }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function safeProperties(root) {
  const file = await child(root, 'server.properties', 'file')
  if (!file) throw new FileOperationError(409, 'properties')
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > maxProperties || file.info.ino !== info.ino || file.info.dev !== info.dev) {
      throw new FileOperationError(409, 'properties')
    }
    const bytes = Buffer.alloc(info.size)
    const result = await handle.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead !== bytes.length || (await handle.stat()).mtimeMs !== info.mtimeMs) throw new FileOperationError(409, 'changed')
    return { ...inspectProperties(bytes), bytes, info, path: file.path }
  } finally {
    await handle.close()
  }
}

export async function readWorldName(root) {
  return configuredWorld((await safeProperties(root)).bytes)
}

async function catalog(root) {
  const visible = []
  for (const name of [...directories, ...knownFiles]) {
    const kind = directories.includes(name) ? 'directory' : 'file'
    const item = await child(root, name, kind)
    if (item) visible.push({ name, kind, size: kind === 'file' ? item.info.size : null })
  }
  const groups = await Promise.all(['mods', 'config'].map(async (name) => {
    const folder = await child(root, name, 'directory')
    if (!folder) return []
    const items = (await readdir(folder.path, { withFileTypes: true }))
      .filter((item) => item.isFile() && safeFilename.test(item.name) && (name !== 'mods' || item.name.toLowerCase().endsWith('.jar')))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)
    const entries = await Promise.all(items.map(async ({ name: file }) => {
      const item = await child(folder.path, file, 'file')
      return item ? { name: file, size: item.info.size, modifiedAt: item.info.mtimeMs } : null
    }))
    return entries.filter(Boolean)
  }))
  return { entries: visible, mods: groups[0], config: groups[1] }
}

function validHistoryRow(row) {
  if (typeof row?.id !== 'string' || !operationId.test(row.id) || typeof row.actor !== 'string'
    || !['edit', 'restore'].includes(row.kind) || !['pending', 'applied', 'rejected'].includes(row.status)
    || ![row.beforeRevision, row.afterRevision, row.fingerprint].every((value) => typeof value === 'string' && revisionPattern.test(value))
    || !Number.isSafeInteger(row.requestedAt) || !row.before || !row.after) return false
  const keys = Object.keys(row.before)
  return keys.length > 0 && keys.length === Object.keys(row.after).length && keys.every((key) => Object.hasOwn(propertyFields, key)
    && Object.hasOwn(row.after, key) && (row.before[key] === null || validPropertyChanges({ [key]: row.before[key] }))
    && ((row.kind === 'restore' && row.after[key] === null) || validPropertyChanges({ [key]: row.after[key] })))
}

export function makeFileManager({ root, journal, allowWrites = false, groupId = null, readRunning,
  otherOperation = () => false, now = Date.now }) {
  if (root && !isAbsolute(root)) throw new Error('File source must be absolute')
  let busy = false
  async function history() {
    let items
    try {
      items = JSON.parse(await readFile(journal, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    if (!Array.isArray(items) || items.length > 40 || items.some((row) => !validHistoryRow(row))) throw new Error('Invalid file history')
    return items
  }

  function observed(item, revision) {
    if (item.status !== 'pending') return item
    const status = revision === item.afterRevision ? 'applied' : revision === item.beforeRevision && !busy ? 'rejected' : 'uncertain'
    return { ...item, status }
  }

  async function info() {
    if (!root) return { configured: false, writable: false, modsWritable: false, entries: [], mods: [], config: [], properties: null, history: [] }
    const source = await realpath(root)
    const [files, settings, records] = await Promise.all([
      catalog(source),
      safeProperties(source).catch((error) => { if (error.code === 'properties') return null; throw error }),
      history(),
    ])
    const properties = settings ? { revision: settings.revision, values: settings.values, invalid: settings.invalid } : null
    return { configured: true, writable: allowWrites && properties !== null,
      modsWritable: allowWrites && files.entries.some(({ name }) => name === 'mods'), ...files, properties,
      history: records.map((item) => observed(item, properties?.revision)).reverse() }
  }

  async function checkStopped() {
    try {
      if (await readRunning() !== false) throw new FileOperationError(409, 'running')
    } catch (error) {
      if (error instanceof FileOperationError) throw error
      throw new FileOperationError(503, 'running-unknown')
    }
  }

  async function readRoot() {
    if (!root) throw new FileOperationError(503, 'disabled')
    return realpath(root)
  }

  async function withStopped(operation) {
    if (!root || !allowWrites) throw new FileOperationError(503, 'disabled')
    if (busy || otherOperation()) throw new FileOperationError(409, 'busy')
    busy = true
    try {
      await checkStopped()
      return await operation(await readRoot(), checkStopped)
    } finally {
      busy = false
    }
  }

  async function change(input, actor) {
    const restore = input?.kind === 'restore'
    if (typeof input?.id !== 'string' || !operationId.test(input.id) || input.confirmed !== true
      || typeof input.revision !== 'string' || !revisionPattern.test(input.revision)
      || (restore ? typeof input.from !== 'string' || !operationId.test(input.from)
        : input.kind !== 'edit' || !validPropertyChanges(input.changes))) {
      throw new FileOperationError(400, 'format')
    }
    if (!root || !allowWrites) throw new FileOperationError(503, 'disabled')
    if (busy || otherOperation()) throw new FileOperationError(409, 'busy')
    const intent = restore ? input.from : Object.entries(input.changes).sort(([left], [right]) => left.localeCompare(right))
    const fingerprint = createHash('sha256').update(JSON.stringify([input.kind, input.revision, intent])).digest('hex')
    busy = true
    try {
      const source = await realpath(root)
      const before = await safeProperties(source)
      const items = await history()
      const existing = items.find(({ id }) => id === input.id)
      if (existing) {
        if (existing.actor !== actor || existing.fingerprint !== fingerprint) throw new FileOperationError(409, 'conflict')
        return observed(existing, before.revision)
      }
      if (before.revision !== input.revision) throw new FileOperationError(409, 'changed')
      if (!canShareServerFile(await stat(source), groupId, 0o070) || !canShareServerFile(before.info, groupId, 0o060)) {
        throw new FileOperationError(409, 'file-permissions')
      }
      const baseline = restore ? items.find(({ id }) => id === input.from) : null
      if (restore && (!baseline || observed(baseline, before.revision).status !== 'applied')) throw new FileOperationError(409, 'restore')
      const changes = restore ? baseline.before : input.changes
      if (before.invalid.some((key) => Object.hasOwn(changes, key))) throw new FileOperationError(409, 'unsupported-properties')
      const updates = Object.fromEntries(Object.entries(changes).filter(([key, value]) => before.values[key] !== value))
      if (Object.keys(updates).length === 0) throw new FileOperationError(409, 'unchanged')
      await checkStopped()
      const nextBytes = applyProperties(before.bytes, updates)
      const after = inspectProperties(nextBytes)
      const record = {
        id: input.id, actor, kind: input.kind, status: 'pending', requestedAt: now(), beforeRevision: before.revision,
        fingerprint, afterRevision: after.revision,
        before: Object.fromEntries(Object.keys(updates).map((key) => [key, before.values[key]])), after: updates,
      }
      const snapshot = [...items, record].slice(-40)
      await writeJson(journal, snapshot)
      const temporary = join(source, '.mcc-' + input.id + '.tmp')
      let staged = false
      try {
        const writer = await open(temporary, 'wx', groupId === null ? before.info.mode & 0o777 : 0o600)
        staged = true
        try {
          await writer.writeFile(nextBytes)
          await shareServerFile(writer, groupId, 0o660)
          await writer.sync()
        } finally {
          await writer.close()
        }
        await checkStopped()
        const current = await safeProperties(source)
        const { dev, ino, uid, gid, mode } = before.info
        if (current.revision !== before.revision || current.info.dev !== dev || current.info.ino !== ino
          || current.info.uid !== uid || current.info.gid !== gid || current.info.mode !== mode) {
          throw new FileOperationError(409, 'changed')
        }
        await rename(temporary, before.path)
      } catch (error) {
        await writeJson(journal, [...snapshot.slice(0, -1), { ...record, status: 'rejected' }]).catch(() => {})
        throw error
      } finally {
        if (staged) await rm(temporary, { force: true }).catch(() => {})
      }
      const applied = { ...record, status: 'applied' }
      await writeJson(journal, [...snapshot.slice(0, -1), applied]).catch(() => {})
      return applied
    } finally {
      busy = false
    }
  }
  return { info, change, readRoot, withStopped, get busy() { return busy } }
}
