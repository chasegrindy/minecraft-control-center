import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeJson } from './json-store.mjs'

export const kinds = new Set(['start', 'stop', 'restart'])
const keyPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/

export function validPowerRequest(input) {
  return kinds.has(input?.action) && typeof input?.id === 'string' && keyPattern.test(input.id)
    && (input.action === 'start' || input.confirmed === true)
}

export async function createPowerJournal(file) {
  let entries
  try {
    entries = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    entries = []
  }
  if (!Array.isArray(entries) || entries.some((entry) => !validPowerRequest({ ...entry, confirmed: true })
    || !['pending', 'done', 'rejected', 'uncertain', 'acknowledged'].includes(entry.status))) {
    throw new Error('Invalid MCC power journal')
  }
  return {
    entries,
    save: (next) => writeJson(file, next),
  }
}

export function makePowerController({ journal, read, write, wait = sleep, steps = 26, now = Date.now }) {
  let entries = journal.entries.slice(-32)
  let busy = false
  let storageFailed = false
  // A process can exit after Crafty accepted a command and before MCC observed its result.
  entries = entries.map((entry) => entry.status === 'pending' ? { ...entry, status: 'uncertain' } : entry)

  function publicState() {
    const last = entries.at(-1) ?? null
    return { enabled: !storageFailed, operation: last }
  }

  async function record(operation) {
    const next = [...entries.filter((item) => item.id !== operation.id), operation].slice(-32)
    await journal.save(next)
    entries = next
  }

  async function perform(operation) {
    const finish = (status, reason) => record({ ...operation, status, reason, finishedAt: now() })
    try {
      let before
      try {
        before = await read()
      } catch {
        await finish('rejected', 'stats')
        return
      }
      const kind = operation.action
      if ((kind === 'start') === before.running) {
        await finish('rejected', 'state')
        return
      }
      try {
        await write(kind)
      } catch (error) {
        if ([400, 401, 403, 404, 405].includes(error.status)) {
          await finish('rejected', 'crafty')
          return
        }
        // A transport failure does not tell us whether Crafty queued the action.
      }
      let stopped = false
      for (let attempt = 0; attempt < steps; attempt++) {
        await wait(3000)
        let state
        try {
          state = await read()
        } catch {
          continue
        }
        if (!state.running) stopped = true
        const restarted = state.running && (stopped || (state.startedAt !== null && before.startedAt !== null
          && state.startedAt > before.startedAt))
        const complete = kind === 'start' ? state.running : kind === 'stop' ? !state.running : restarted
        if (complete) {
          await finish('done')
          return
        }
      }
      await finish('uncertain', 'confirmation')
    } catch {
      storageFailed = true
      entries = entries.map((entry) => entry.id === operation.id ? { ...entry, status: 'uncertain' } : entry)
    } finally {
      busy = false
    }
  }

  return {
    get busy() { return busy },
    publicState,
    async request(input, actor) {
      const existing = entries.find((entry) => entry.id === input.id)
      if (existing) {
        if (existing.actor !== actor || existing.action !== input.action) return { status: 409, data: publicState() }
        return { status: 200, data: { enabled: !storageFailed, operation: existing } }
      }
      if (storageFailed) return { status: 503, data: publicState() }
      if (busy || entries.at(-1)?.status === 'uncertain') return { status: 409, data: publicState() }
      busy = true
      const operation = { id: input.id, action: input.action, actor, status: 'pending', requestedAt: now() }
      try {
        await record(operation)
      } catch {
        busy = false
        storageFailed = true
        return { status: 503, data: publicState() }
      }
      void perform(operation)
      return { status: 202, data: publicState() }
    },
    async acknowledge(id, actor) {
      const previous = entries.at(-1)
      if (storageFailed) return { status: 503, data: publicState() }
      if (busy || previous?.status !== 'uncertain' || previous.id !== id) return { status: 409, data: publicState() }
      busy = true
      try {
        await record({ ...previous, status: 'acknowledged', confirmedBy: actor, confirmedAt: now() })
        return { status: 200, data: publicState() }
      } catch {
        storageFailed = true
        return { status: 503, data: publicState() }
      } finally {
        busy = false
      }
    },
  }
}
