import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { makeBackupJobs } from './backup-jobs.mjs'
import { FileOperationError } from './file-manager.mjs'

const previousName = '2026-10-20_11-00-00.zip'
const freshName = '2026-10-25_02-30-00.zip'
const confirmed = (kind, input = {}) => ({ id: randomUUID(), kind, confirmed: true, allowDowntime: false, ...input })

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mcc-backup-jobs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'jobs.json')
  const recorded = []
  const names = [previousName]
  let time = Date.parse('2026-10-25T00:00:00Z')
  let running = false
  let keep = 0
  const archives = {
    accepts: async () => true,
    inspect: async (name) => names.includes(name) ? { name, size: 100, files: 4, modifiedAt: 1000 } : null,
    usage: async (listed) => ({ count: listed.length, bytes: listed.length * 100 }),
  }
  const client = {
    async backupProfile() { return { zip: true, enabled: true, hooks: false, shutdown: true, keep, state: 'ready' } },
    async backupFiles() { return names.slice() },
    async queueBackup() { recorded.push('create'); names.unshift(freshName) },
    async restoreBackup(name) { recorded.push('restore:' + name) },
  }
  const options = { file, client, archives, readRunning: async () => running,
    now: () => time, wait: async () => {}, attempts: 2, interval: 0 }
  return { jobs: await makeBackupJobs(options), options, recorded,
    setTime: (value) => { time = Date.parse(value) }, setKeep: (value) => { keep = value }, setRunning: (value) => { running = value } }
}

async function waitFor(jobs, status) {
  for (let attempt = 0; attempt < 200 && jobs.publicState().history[0]?.status !== status; attempt++) await delay(5)
  assert.equal(jobs.publicState().history[0]?.status, status)
}

test('dzienny harmonogram w Polsce wykonuje godzinę powtórzoną podczas zmiany czasu tylko raz', async (t) => {
  const { jobs, recorded, setTime, options } = await fixture(t)
  await jobs.request(confirmed('schedule', { enabled: true, time: '02:30' }), 'mcc')
  setTime('2026-10-25T00:30:10Z')
  await jobs.tick()
  await waitFor(jobs, 'done')
  setTime('2026-10-25T01:30:05Z')
  const restarted = await makeBackupJobs(options)
  await restarted.tick()
  assert.deepEqual(recorded, ['create'])
  assert.equal(restarted.publicState().history[0].archive.name, freshName)
})

test('odmawia zapisu przy działającej grze i przywrócenia, które mogłoby wyprzeć źródłową kopię', async (t) => {
  const { jobs, recorded, setRunning, setKeep } = await fixture(t)
  setRunning(true)
  await assert.rejects(jobs.request(confirmed('create'), 'mcc'), { code: 'backup-running' })
  setRunning(false)
  setKeep(1)
  await assert.rejects(jobs.request(confirmed('restore', { target: previousName }), 'mcc'), { code: 'backup-retention' })
  assert.deepEqual(recorded, [])
})

test('przywraca dopiero po nowej kopii i wymaga sprawdzenia w Crafty przed zwolnieniem blokady', async (t) => {
  const { jobs, recorded } = await fixture(t)
  const request = confirmed('restore', { target: previousName })
  assert.equal((await jobs.request(request, 'mcc')).status, 202)
  await waitFor(jobs, 'restore-review')
  assert.deepEqual(recorded, ['create', 'restore:' + previousName])
  assert.equal(jobs.publicState().history[0].archive.name, freshName)
  assert.equal(jobs.busy, true)
  await assert.rejects(jobs.request(confirmed('create'), 'mcc'), { code: 'backup-busy' })
  assert.equal((await jobs.request(request, 'mcc')).status, 200)
  await jobs.request(confirmed('acknowledge', { id: request.id }), 'mcc')
  assert.equal(jobs.busy, false)
  assert.equal(jobs.publicState().history[0].status, 'acknowledged')
})

test('ponowne uruchomienie nie ponawia niezakończonej kopii', async (t) => {
  const { options, recorded } = await fixture(t)
  const pending = { ...confirmed('create'), status: 'pending', actor: 'mcc', requestedAt: options.now() }
  await writeFile(options.file, JSON.stringify({ history: [pending], schedule: null }))
  const restored = await makeBackupJobs(options)
  assert.equal(restored.publicState().history[0].status, 'uncertain')
  assert.equal(restored.busy, true)
  await restored.request(pending, 'mcc')
  assert.deepEqual(recorded, [])
})

test('przywraca świat po utworzeniu kopii bezpieczeństwa i zapisuje wynik bez zlecenia do Crafty', async (t) => {
  const { jobs, options, recorded } = await fixture(t)
  const request = confirmed('restore', { target: previousName, mode: 'world' })
  await assert.rejects(jobs.request(request, 'mcc'), { code: 'world-disabled' })
  const world = await makeBackupJobs({ ...options, worldRestore: { async replace(id, source) {
    assert.equal(id, request.id)
    assert.equal(source.name, previousName)
    recorded.push('replace')
    return { files: 9 }
  } } })
  assert.equal(world.publicState().worldRestore, true)
  assert.equal((await world.request(request, 'mcc')).status, 202)
  await waitFor(world, 'done')
  assert.deepEqual(recorded, ['create', 'replace'])
  assert.equal(world.publicState().history[0].worldFiles, 9)
  assert.equal(world.busy, false)
  assert.deepEqual((await world.list()).usage, { count: 2, bytes: 200 })
})

test('po niepewnej podmianie tylko sprawdzenie stanu świata zwalnia blokadę po restarcie', async (t) => {
  const { options, recorded } = await fixture(t)
  const request = confirmed('restore', { target: previousName, mode: 'world' })
  const worldRestore = {
    async replace() { throw new FileOperationError(409, 'world-recovery') },
    async recover(id) {
      assert.equal(id, request.id)
      return { status: 'original' }
    },
  }
  const configured = { ...options, worldRestore }
  const jobs = await makeBackupJobs(configured)
  await jobs.request(request, 'mcc')
  await waitFor(jobs, 'uncertain')
  const restarted = await makeBackupJobs(configured)
  assert.equal(restarted.busy, true)
  await assert.rejects(restarted.request(confirmed('acknowledge', { id: request.id }), 'mcc'), { code: 'world-recovery' })
  await restarted.request(confirmed('recover-world', { id: request.id }), 'mcc')
  assert.equal(restarted.publicState().history[0].worldOutcome, 'original')
  assert.equal(restarted.busy, false)
  assert.deepEqual(recorded, ['create'])
})
