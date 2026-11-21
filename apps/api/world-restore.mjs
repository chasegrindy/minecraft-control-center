import { lstat, mkdir, open, readFile, realpath, rename, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { child, FileOperationError, operationId, readWorldName } from './file-manager.mjs'
import { writeJson } from './json-store.mjs'
import { canShareServerFile } from './server-file-access.mjs'

const marker = 'swap.json'
const worldPattern = /^[A-Za-z0-9_-]{1,64}$/

function error(code) {
  return new FileOperationError(409, code)
}

async function identity(path) {
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory()) throw error('world-recovery')
    return { id: info.dev + ':' + info.ino, mtime: String(info.mtimeNs), uid: Number(info.uid),
      gid: Number(info.gid), mode: Number(info.mode) }
  } catch (problem) {
    if (problem.code === 'ENOENT') return null
    throw problem
  }
}

async function sync(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function syncDirectories(...paths) {
  if (process.platform !== 'win32') {
    for (const path of paths) await sync(path)
  }
}

export function makeWorldRestore({ root, world, archives, readRunning, groupId = null, move = rename }) {
  if (!isAbsolute(root) || typeof world !== 'string' || !worldPattern.test(world)) throw new Error('Invalid world restore configuration')

  async function stopped() {
    if (await readRunning() !== false) throw error('backup-running')
  }

  async function paths(id, create) {
    if (typeof id !== 'string' || !operationId.test(id)) throw error('format')
    const server = await realpath(root)
    if (await readWorldName(server) !== world) throw error('world-name')
    const parent = dirname(server)
    const work = join(parent, '.mcc-world-recovery-' + basename(server))
    if (server === parent) throw error('world-recovery')
    if (create) await mkdir(work, { mode: 0o700 }).catch((problem) => {
      if (problem.code !== 'EEXIST') throw problem
    })
    const workInfo = await identity(work)
    const current = join(server, world)
    if (!workInfo && !create) return { current }
    const slot = join(work, id)
    if (create) {
      if ((await stat(server, { bigint: true })).dev !== (await lstat(work, { bigint: true })).dev) throw error('world-storage')
      await mkdir(slot, { mode: 0o700 })
    }
    if (!(await identity(slot)) && !create) return { current }
    return { server, parent, work, slot, current, previous: join(slot, 'previous'),
      replacement: join(slot, 'replacement'), record: join(slot, marker) }
  }

  async function recover(id) {
    await stopped()
    const pathsNow = await paths(id, false)
    const active = await identity(pathsNow.current)
    if (!pathsNow.slot && active) return { status: 'original' }
    if (!pathsNow.slot) throw error('world-recovery')
    const previous = await identity(pathsNow.previous)
    const markerInfo = await lstat(pathsNow.record).catch((problem) => {
      if (problem.code === 'ENOENT') return null
      throw problem
    })
    if (!markerInfo && active && !previous) return { status: 'original' }
    const file = await child(pathsNow.slot, marker, 'file')
    if (!file || file.info.size > 4096) throw error('world-recovery')
    const record = JSON.parse(await readFile(file.path, 'utf8'))
    if (record?.id !== id || record.world !== world || !/^\d+:\d+$/.test(record.before) || !/^\d+:\d+$/.test(record.after)
      || !Number.isSafeInteger(record.files) || record.files < 1) {
      throw error('world-recovery')
    }
    if (active?.id === record.after && previous?.id === record.before) {
      await syncDirectories(pathsNow.slot, pathsNow.server)
      return { status: 'restored', files: record.files }
    }
    if (active?.id === record.before && !previous) return { status: 'original' }
    if (active || previous?.id !== record.before) throw error('world-recovery')
    await stopped()
    await move(pathsNow.previous, pathsNow.current)
    await syncDirectories(pathsNow.slot, pathsNow.server)
    return { status: 'original' }
  }

  async function replace(id, source) {
    await stopped()
    const pathsNow = await paths(id, true)
    const initial = await identity(pathsNow.current)
    if (!initial) throw error('world-changed')
    if (!canShareServerFile(initial, groupId, 0o070)) throw error('world-permissions')
    await mkdir(pathsNow.replacement, { mode: 0o750 })
    const files = await archives.extractWorld(source, pathsNow.replacement, groupId)
    const ready = await identity(pathsNow.replacement)
    if (!ready || !Number.isSafeInteger(files) || files < 1) throw error('world-extract')
    await writeJson(pathsNow.record, { id, world, before: initial.id, after: ready.id, files }, { durable: true })
    await syncDirectories(pathsNow.work, pathsNow.server, pathsNow.parent)
    await stopped()
    const active = await identity(pathsNow.current)
    if (active?.id !== initial.id || active.mtime !== initial.mtime || active.uid !== initial.uid
      || active.gid !== initial.gid || active.mode !== initial.mode || await readWorldName(pathsNow.server) !== world) {
      throw error('world-changed')
    }

    try {
      await move(pathsNow.current, pathsNow.previous)
    } catch {
      throw error('world-swap')
    }
    try {
      await move(pathsNow.replacement, pathsNow.current)
      await syncDirectories(pathsNow.slot, pathsNow.server)
      if ((await identity(pathsNow.current))?.id !== ready.id || (await identity(pathsNow.previous))?.id !== initial.id) {
        throw error('world-recovery')
      }
    } catch {
      const result = await recover(id).catch(() => null)
      if (result?.status === 'original') throw error('world-swap')
      if (result?.status !== 'restored') throw error('world-recovery')
    }
    return { files }
  }

  return { replace, recover }
}
