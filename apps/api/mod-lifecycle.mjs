import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FileOperationError, child, operationId } from './file-manager.mjs'
import { inspectFabricMod, matchesFabricVersion, maxModBytes, modDigest, modFilename, scanFabricArchive } from './fabric-mod.mjs'
import { writeJson } from './json-store.mjs'
import { canShareServerFile, shareServerFile } from './server-file-access.mjs'

const maxInstalledBytes = 256 * 1024 * 1024
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const compatibleFile = (name) => typeof name === 'string' && modFilename.test(name)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)

async function matchesFile(path, info) {
  try {
    const current = await lstat(path)
    return current.isFile() && current.ino === info.ino && current.dev === info.dev
      && current.size === info.size && current.mtimeMs === info.mtimeMs
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function modFile(directory, name) {
  const file = await child(directory, name, 'file')
  if (!file || file.info.nlink !== 1 || file.info.size < 1 || file.info.size > maxInstalledBytes) {
    throw new FileOperationError(409, 'mod-changed')
  }
  return file
}

async function useMod(file, read) {
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.ino !== file.info.ino || info.dev !== file.info.dev || info.size !== file.info.size
      || info.mtimeMs !== file.info.mtimeMs) throw new FileOperationError(409, 'mod-changed')
    const value = await read(handle)
    if (!(await matchesFile(file.path, info))) throw new FileOperationError(409, 'mod-changed')
    return value
  } finally {
    await handle.close()
  }
}

async function fileBytes(file) {
  if (file.info.size > maxModBytes) throw new FileOperationError(413, 'mod-size')
  return useMod(file, (handle) => handle.readFile())
}

async function scanInstalled(directory, budget) {
  const groups = new Map()
  const entries = await readdir(directory, { withFileTypes: true })
  const jars = entries.filter(({ name }) => name.toLowerCase().endsWith('.jar'))
  if (jars.length > 200) throw new FileOperationError(409, 'mod-inventory')
  for (const entry of jars) {
    if (!entry.isFile()) throw new FileOperationError(409, 'mod-inventory')
    const file = await modFile(directory, entry.name)
    const mods = await useMod(file, (handle) => scanFabricArchive({
      getLength: async () => file.info.size,
      async read(offset, size) {
        if (offset < 0 || size < 0 || size > maxModBytes || offset + size > file.info.size) {
          throw new FileOperationError(409, 'mod-inventory')
        }
        const data = Buffer.alloc(size)
        const { bytesRead } = await handle.read(data, 0, size, offset)
        if (bytesRead !== size) throw new FileOperationError(409, 'mod-changed')
        return data
      },
    }, budget, true))
    groups.set(entry.name, { file, mods })
  }
  return groups
}

function providers(mods, versions) {
  const result = new Map(Object.entries(versions).map(([id, version]) => [id, [version]]))
  for (const mod of mods) {
    for (const name of [mod.id, ...mod.provides]) result.set(name, [...(result.get(name) ?? []), mod.version])
  }
  return result
}

function dependencies(mods, available) {
  return new Set(mods.flatMap((mod) => Object.entries(mod.depends)
    .filter(([id, range]) => !(available.get(id) ?? []).some((version) => matchesFabricVersion(range, version) === true))
    .map(([id]) => mod.id + ' → ' + id)))
}

function breaks(mods, available) {
  return new Set(mods.flatMap((mod) => Object.entries(mod.breaks)
    .filter(([id, range]) => (available.get(id) ?? []).some((version) => matchesFabricVersion(range, version) !== false))
    .map(([id]) => mod.id + ' × ' + id)))
}

function ensureCompatible(existing, candidate, versions) {
  const current = providers(existing, versions)
  const combined = providers([...existing, ...candidate], versions)
  const prior = breaks(existing, current)
  const issues = new Set([...dependencies(candidate, combined), ...breaks(candidate, combined),
    ...[...breaks(existing, combined)].filter((value) => !prior.has(value))])
  if (issues.size) throw dependencyError(issues)
}

function dependencyError(issues) {
  return Object.assign(new FileOperationError(409, 'mod-dependencies'), { details: [...issues].slice(0, 20) })
}

async function assertInventoryCurrent(root, directory, installed) {
  const current = await child(root, 'mods', 'directory')
  if (!current || current.info.dev !== directory.info.dev || current.info.ino !== directory.info.ino) {
    throw new FileOperationError(409, 'mod-changed')
  }
  for (const { file } of installed.values()) {
    if (!(await matchesFile(file.path, file.info))) throw new FileOperationError(409, 'mod-changed')
  }
  const currentJars = (await readdir(directory.path)).filter((name) => name.toLowerCase().endsWith('.jar'))
  if (currentJars.length !== installed.size || currentJars.some((name) => !installed.has(name))) {
    throw new FileOperationError(409, 'mod-changed')
  }
  return current.info
}

async function archiveFolder(root, create) {
  const name = '.mcc-removed-mods'
  if (create) await mkdir(join(root, name), { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  return child(root, name, 'directory')
}

async function archiveSlot(root, id) {
  const folder = await archiveFolder(root, false)
  return folder && child(folder.path, id, 'directory')
}

async function writeWithoutReplacing(directory, record, bytes, stopped, groupId) {
  const temporary = join(directory, '.mcc-' + record.id + '.tmp')
  const handle = await open(temporary, 'wx', groupId === null ? 0o640 : 0o600)
  try {
    try {
      await handle.writeFile(bytes)
      await shareServerFile(handle, groupId, 0o640)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await stopped()
    await link(temporary, join(directory, record.file)).catch((error) => {
      if (error.code === 'EEXIST') throw new FileOperationError(409, 'mod-exists')
      throw error
    })
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function operation(input) {
  if (typeof input?.id !== 'string' || !operationId.test(input.id) || input.confirmed !== true) {
    throw new FileOperationError(400, 'format')
  }
  if (input.kind === 'install' && typeof input.digest === 'string' && modDigest.test(input.digest)) return [input.kind, input.digest]
  if (input.kind === 'restore' && typeof input.from === 'string' && operationId.test(input.from)) return [input.kind, input.from]
  if (input.kind === 'remove' && compatibleFile(input.file) && Number.isSafeInteger(input.size)
    && Number.isFinite(input.modifiedAt)) return [input.kind, input.file, input.size, input.modifiedAt]
  throw new FileOperationError(400, 'format')
}

export function makeModLifecycle({ files, staging, journal, versions, groupId = null, now = Date.now }) {
  let checking = false

  async function readInstalled(root, writable = false) {
    const directory = await child(root, 'mods', 'directory')
    if (!directory) throw new FileOperationError(409, 'mod-inventory')
    if (writable && !canShareServerFile(directory.info, groupId, 0o070)) throw new FileOperationError(409, 'file-permissions')
    const config = await child(root, 'config', 'directory')
    if (config && (await readdir(config.path)).includes('fabric_loader_dependencies.json')) {
      throw new FileOperationError(409, 'mod-inventory')
    }
    const budget = { archives: 0, bytes: 0 }
    const installed = await scanInstalled(directory.path, budget)
    const all = [...installed.values()].flatMap(({ mods }) => mods)
    return { directory, installed, all, budget }
  }

  async function checkCandidate({ file, bytes, source }, { installed, all, budget }) {
    if (!compatibleFile(file)) throw new FileOperationError(400, 'mod-name')
    if ([...installed.keys()].some((name) => name.toLowerCase() === file.toLowerCase())) throw new FileOperationError(409, 'mod-exists')
    const report = await inspectFabricMod(bytes, versions)
    const sameEnvironment = source && Object.keys(versions).every((key) => source.versions?.[key] === versions[key])
    if (report.verdict !== 'yes' && !sameEnvironment) throw new FileOperationError(409, 'mod-compatibility')
    const added = await scanFabricArchive(bytes, budget)
    if (providers(all, versions).has(report.id)) throw new FileOperationError(409, 'mod-exists')
    ensureCompatible(all, added, versions)
  }

  async function checkStaged(digest) {
    if (checking || files.busy) throw new FileOperationError(409, 'busy')
    checking = true
    try {
      const candidate = await staging.read(digest)
      const root = await files.readRoot()
      const inventory = await readInstalled(root)
      await checkCandidate(candidate, inventory)
      await assertInventoryCurrent(root, inventory.directory, inventory.installed)
      return { checkedAt: now() }
    } finally {
      checking = false
    }
  }

  async function readRecord(id) {
    const path = join(journal, id + '.json')
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > 8192) throw new Error('Invalid mod history')
      const row = JSON.parse(await readFile(path, 'utf8'))
      if (row?.id !== id || !['install', 'remove', 'restore'].includes(row.kind) || !compatibleFile(row.file)
        || !['pending', 'applied', 'rejected'].includes(row.status) || !Number.isFinite(row.requestedAt)
        || typeof row.digest !== 'string' || !modDigest.test(row.digest)) throw new Error('Invalid mod history')
      return row
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  function publicRecord(row) {
    const { fingerprint, ...fields } = row
    return { ...fields, status: row.status === 'pending' ? 'uncertain' : row.status }
  }

  function duplicate(row, actor, fingerprint) {
    if (row.actor !== actor || row.fingerprint !== fingerprint) throw new FileOperationError(409, 'conflict')
    return publicRecord(row)
  }

  async function history() {
    let names
    try { names = await readdir(journal) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const rows = await Promise.all(names.filter((name) => name.endsWith('.json') && operationId.test(name.slice(0, -5)))
      .map((name) => readRecord(name.slice(0, -5))))
    return rows.filter(Boolean).sort((a, b) => b.requestedAt - a.requestedAt).slice(0, 40).map(publicRecord)
  }

  async function change(input, actor) {
    const fingerprint = sha256(JSON.stringify(operation(input)))
    const previous = await readRecord(input.id)
    if (previous) return duplicate(previous, actor, fingerprint)
    if (checking) throw new FileOperationError(409, 'busy')
    return files.withStopped(async (root, stopped) => {
      const recorded = await readRecord(input.id)
      if (recorded) return duplicate(recorded, actor, fingerprint)
      const inventory = await readInstalled(root, true)
      const { directory, installed, all } = inventory
      let file, digest, bytes, removing, source
      if (input.kind === 'remove') {
        file = input.file
        removing = installed.get(file)
        if (!removing || removing.file.info.size !== input.size
          || removing.file.info.mtimeMs !== input.modifiedAt) throw new FileOperationError(409, 'mod-changed')
        const bytes = await fileBytes(removing.file)
        await inspectFabricMod(bytes, versions)
        const remaining = [...installed.entries()].filter(([name]) => name !== file).flatMap(([, value]) => value.mods)
        const prior = dependencies(remaining, providers(all, versions))
        const affected = [...dependencies(remaining, providers(remaining, versions))].filter((issue) => !prior.has(issue))
        if (affected.length) throw dependencyError(affected)
        digest = sha256(bytes)
      } else {
        if (input.kind === 'install') {
          ({ file, bytes } = await staging.read(input.digest))
          digest = input.digest
        } else {
          source = await readRecord(input.from)
          const slot = source?.kind === 'remove' && source.status !== 'rejected' ? await archiveSlot(root, source.id) : null
          if (!slot) throw new FileOperationError(409, 'mod-archive')
          file = source.file
          const archived = await modFile(slot.path, 'mod.jar')
          bytes = await fileBytes(archived)
          digest = sha256(bytes)
          if (digest !== source.digest) throw new FileOperationError(409, 'mod-archive')
        }
        await checkCandidate({ file, bytes, source }, inventory)
      }
      await stopped()
      const current = await assertInventoryCurrent(root, directory, installed)
      if (!canShareServerFile(current, groupId, 0o070)) throw new FileOperationError(409, 'mod-changed')
      await mkdir(journal, { recursive: true, mode: 0o700 })
      const recordPath = join(journal, input.id + '.json')
      // The shared maintenance lock remains held until the result is recorded.
      const record = { id: input.id, actor, fingerprint, kind: input.kind, file, digest, versions, status: 'pending', requestedAt: now() }
      await writeJson(recordPath, record)
      try {
        if (removing) {
          const archive = await archiveFolder(root, true)
          if (!archive) throw new FileOperationError(409, 'mod-archive')
          const slot = join(archive.path, record.id)
          await mkdir(slot, { mode: 0o700 })
          try {
            await stopped()
            if (!(await matchesFile(removing.file.path, removing.file.info))) throw new FileOperationError(409, 'mod-changed')
            await rename(removing.file.path, join(slot, 'mod.jar'))
          } catch (error) {
            await rmdir(slot).catch(() => {})
            throw error
          }
        } else {
          await writeWithoutReplacing(directory.path, record, bytes, stopped, groupId)
        }
      } catch (error) {
        await writeJson(recordPath, { ...record, status: 'rejected' }).catch(() => {})
        throw error
      }
      const applied = { ...record, status: 'applied' }
      await writeJson(recordPath, applied).catch(() => {})
      return publicRecord(applied)
    })
  }

  return { history, checkStaged, change }
}
