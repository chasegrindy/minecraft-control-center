import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isCraftyZip } from './crafty.mjs'
import { FileOperationError, operationId } from './file-manager.mjs'
import { writeJson } from './json-store.mjs'

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const statuses = new Set(['pending', 'done', 'rejected', 'uncertain', 'restore-review', 'acknowledged', 'skipped'])
const protectedStates = new Set(['pending', 'uncertain', 'restore-review'])
const safeWorldFailures = new Set(['backup-running', 'backup-source', 'world-name', 'world-changed', 'world-extract',
  'world-space', 'world-storage', 'world-swap', 'world-permissions'])
const zone = 'Europe/Warsaw'
const wallClock = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' })

function localSlot(at) {
  const [day, time] = wallClock.format(at).split(' ')
  return { day, time }
}

function validatesSchedule(value) {
  return typeof value?.enabled === 'boolean' && typeof value.time === 'string' && timePattern.test(value.time)
    && typeof value.allowDowntime === 'boolean'
}

function validatesHistory(job) {
  return typeof job?.id === 'string' && operationId.test(job.id) && typeof job.actor === 'string'
    && ['create', 'restore'].includes(job.kind) && statuses.has(job.status) && Number.isSafeInteger(job.requestedAt)
    && typeof job.allowDowntime === 'boolean' && (job.kind !== 'restore' || isCraftyZip(job.target))
    && (job.mode === undefined || (job.kind === 'restore' && job.mode === 'world'))
    && (job.worldSwap === undefined || (job.mode === 'world' && job.worldSwap === true))
}

export async function makeBackupJobs({
  file, client, archives, readRunning, worldRestore = null, otherOperation = () => false,
  now = Date.now, wait = delay, attempts = 90, interval = 10_000,
}) {
  let state
  try {
    state = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { schedule: null, history: [] }
  }
  if (!state || !Array.isArray(state.history) || state.history.length > 30 || !state.history.every(validatesHistory)
    || (state.schedule !== null && (!validatesSchedule(state.schedule)
      || typeof state.schedule.actor !== 'string'
      || (state.schedule.lastDay !== null && !dayPattern.test(state.schedule.lastDay))))) throw new Error('Invalid MCC backup journal')
  state.history = state.history.map((entry) => entry.status === 'pending' ? { ...entry, status: 'uncertain', reason: 'restart' } : entry)
  let busy = false
  let storageError = false
  const last = () => state.history.at(-1)
  const blocked = () => busy || protectedStates.has(last()?.status)
  const publicState = () => ({ enabled: !storageError, worldRestore: Boolean(worldRestore), schedule: state.schedule,
    timezone: zone, history: state.history.slice().reverse(), blocked: blocked() })

  async function save(value) {
    try {
      await writeJson(file, value, { durable: true })
      state = value
    } catch {
      storageError = true
      throw new FileOperationError(503, 'backup-journal')
    }
  }

  function withEntry(entry, schedule = state.schedule) {
    return { schedule, history: [...state.history.filter(({ id }) => id !== entry.id), entry].slice(-30) }
  }

  async function profile() {
    const selected = await client.backupProfile()
    if (!selected.enabled || !selected.zip || selected.hooks || !(await archives.accepts(selected.location))) {
      throw new FileOperationError(409, 'backup-profile')
    }
    if (selected.state === 'busy') throw new FileOperationError(409, 'backup-busy')
    return selected
  }

  async function canRun(selected, allowDowntime, restore) {
    const running = await readRunning()
    if (running !== false && (restore || running !== true || !allowDowntime || !selected.shutdown)) {
      throw new FileOperationError(409, 'backup-running')
    }
  }

  async function newCopy(names) {
    try {
      await client.queueBackup()
    } catch (error) {
      if ([400, 401, 403, 404, 405].includes(error.status)) throw new FileOperationError(502, 'backup-rejected')
      // A lost response can follow a successful queue request.
    }
    const baseline = new Set(names)
    for (let step = 0; step < attempts; step++) {
      await wait(interval)
      try {
        const [selected, listed] = await Promise.all([client.backupProfile(), client.backupFiles()])
        if (selected.state !== 'ready') continue
        const added = listed.filter((name) => !baseline.has(name))
        if (added.length > 1) throw new FileOperationError(409, 'backup-extra')
        if (added.length === 1) {
          const archive = await archives.inspect(added[0])
          if (archive) return archive
        }
      } catch (error) {
        if (error instanceof FileOperationError) throw error
      }
    }
    throw new FileOperationError(504, 'backup-timeout')
  }

  async function run(job, names, source) {
    let snapshot
    let restoreDispatch = false
    const replaceWorld = job.mode === 'world'
    try {
      snapshot = await newCopy(names)
      if (!source) {
        await save(withEntry({ ...job, status: 'done', archive: snapshot, finishedAt: now() }))
        return
      }
      await canRun(await profile(), false, true)
      const intact = await archives.inspect(source.name)
      if (!intact || intact.size !== source.size || intact.modifiedAt !== source.modifiedAt) throw new FileOperationError(409, 'backup-source')
      const readyToRestore = { ...job, archive: snapshot, ...(replaceWorld ? { worldSwap: true } : {}) }
      await save(withEntry(readyToRestore))
      restoreDispatch = true
      if (replaceWorld) {
        const { files } = await worldRestore.replace(job.id, intact)
        await save(withEntry({ ...readyToRestore, status: 'done', worldFiles: files, finishedAt: now() }))
      } else {
        await client.restoreBackup(job.target)
        await save(withEntry({ ...readyToRestore, status: 'restore-review', finishedAt: now() }))
      }
    } catch (error) {
      const fallback = restoreDispatch || !snapshot
      const restoreRejected = replaceWorld ? safeWorldFailures.has(error.code) : [400, 401, 403, 404, 405].includes(error.status)
      const definite = error.code === 'backup-rejected' || (restoreDispatch && restoreRejected)
      const status = fallback && !definite ? 'uncertain' : 'rejected'
      const finished = { ...job, ...(snapshot ? { archive: snapshot } : {}), ...(replaceWorld && restoreDispatch ? { worldSwap: true } : {}), status,
        reason: error instanceof FileOperationError ? error.code : 'backup-request', finishedAt: now() }
      try { await save(withEntry(finished)) } catch {
        state = withEntry({ ...finished, status: 'uncertain', reason: 'backup-journal' })
      }
    } finally {
      busy = false
    }
  }

  async function start(job, selectedSchedule = state.schedule) {
    if (job.mode === 'world' && !worldRestore) throw new FileOperationError(409, 'world-disabled')
    const selected = await profile()
    const names = await client.backupFiles()
    let source = null
    if (job.kind === 'restore') {
      if (!names.includes(job.target)) throw new FileOperationError(409, 'backup-source')
      if (selected.keep === null || (selected.keep > 0 && names.length >= selected.keep)) {
        throw new FileOperationError(409, 'backup-retention')
      }
      source = await archives.inspect(job.target)
      if (!source) throw new FileOperationError(409, 'backup-source')
    }
    await canRun(selected, job.allowDowntime, job.kind === 'restore')
    await save(withEntry(job, selectedSchedule))
    void run(job, names, source)
  }

  async function request(input, actor) {
    if (!input || input.confirmed !== true) throw new FileOperationError(400, 'format')
    if (storageError) throw new FileOperationError(503, 'backup-journal')
    if (input.kind === 'acknowledge' || input.kind === 'recover-world') {
      const prior = last()
      if (busy || !['uncertain', 'restore-review'].includes(prior?.status) || input.id !== prior.id) {
        throw new FileOperationError(409, 'backup-busy')
      }
      const recoverWorld = input.kind === 'recover-world'
      if (Boolean(prior.worldSwap) !== recoverWorld) throw new FileOperationError(409, 'world-recovery')
      if (recoverWorld && !worldRestore) throw new FileOperationError(409, 'world-disabled')
      if (recoverWorld && otherOperation()) throw new FileOperationError(409, 'backup-busy')
      busy = true
      try {
        const result = recoverWorld ? await worldRestore.recover(prior.id) : null
        const { reason, ...entry } = prior
        const outcome = result?.status === 'restored'
          ? { status: 'done', worldFiles: result.files, finishedAt: now() }
          : { status: 'acknowledged', ...(result ? { worldOutcome: 'original' } : { reason }) }
        await save(withEntry({ ...entry, ...outcome, acknowledgedAt: now(), acknowledgedBy: actor }))
      } finally {
        busy = false
      }
      return { status: 200 }
    }
    if (input.kind === 'schedule') {
      if (!validatesSchedule(input)) throw new FileOperationError(400, 'format')
      if (busy) throw new FileOperationError(409, 'backup-busy')
      busy = true
      try {
        if (input.enabled) {
          const selected = await profile()
          if (input.allowDowntime && !selected.shutdown) throw new FileOperationError(409, 'backup-profile')
        }
        const { day, time } = localSlot(now())
        const lastDay = time >= input.time ? day : state.schedule?.lastDay ?? null
        await save({ ...state, schedule: { enabled: input.enabled, time: input.time, allowDowntime: input.allowDowntime, actor, lastDay } })
      } finally {
        busy = false
      }
      return { status: 200 }
    }
    const job = { id: input.id, kind: input.kind, actor, status: 'pending', requestedAt: now(), allowDowntime: input.allowDowntime,
      ...(input.kind === 'restore' ? { target: input.target, mode: input.mode === 'files' ? undefined : input.mode } : {}) }
    if (!validatesHistory(job) || (job.kind === 'restore' && job.allowDowntime)) throw new FileOperationError(400, 'format')
    const existing = state.history.find(({ id }) => id === job.id)
    if (existing) {
      if (existing.actor !== actor || existing.kind !== job.kind || existing.target !== job.target
        || existing.allowDowntime !== job.allowDowntime || existing.mode !== job.mode) throw new FileOperationError(409, 'conflict')
      return { status: 200 }
    }
    if (blocked() || otherOperation()) throw new FileOperationError(409, 'backup-busy')
    busy = true
    try {
      await start(job)
      return { status: 202 }
    } catch (error) {
      busy = false
      throw error
    }
  }

  async function tick() {
    const schedule = state.schedule
    if (busy || storageError || !schedule?.enabled) return
    const { day, time } = localSlot(now())
    if (time !== schedule.time || schedule.lastDay === day) return
    const previousBlocked = blocked() || otherOperation()
    const marked = { ...schedule, lastDay: day }
    const job = { id: randomUUID(), actor: schedule.actor, kind: 'create', scheduled: true, requestedAt: now(),
      allowDowntime: schedule.allowDowntime, status: 'pending' }
    busy = true
    try {
      if (previousBlocked) {
        // A skipped slot must not replace a restore or uncertainty that still needs review.
        await save({ ...state, schedule: marked })
        busy = false
        return
      }
      await start(job, marked)
    } catch (error) {
      try {
        await save(withEntry({ ...job, status: 'skipped', reason: error instanceof FileOperationError ? error.code : 'backup-request' }, marked))
      } finally {
        busy = false
      }
    }
  }

  async function list() {
    const selected = await profile()
    const names = await client.backupFiles()
    const usage = await archives.usage(names)
    const verified = []
    for (const name of names.slice(0, 50)) {
      const data = await archives.inspect(name)
      if (data) verified.push(data)
    }
    return { shutdown: selected.shutdown, archives: verified, usage }
  }

  async function download(name) {
    if (!isCraftyZip(name)) return null
    await profile()
    if (!(await client.backupFiles()).includes(name)) return null
    return archives.download(name)
  }

  return { publicState, request, tick, list, download, get busy() { return blocked() } }
}
