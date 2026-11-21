import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMetricHistory } from './metric-history.mjs'

const minute = 60_000
const hour = 60 * minute
const midnight = Date.UTC(2026, 10, 19)

test('trwała historia zachowuje przerwy i pojedynczą próbkę w każdej minucie', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-metric-history-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let now = midnight - minute * 2 + 10_000
  const history = await openMetricHistory(directory, () => now)
  await history.record({ time: now, cpu: 1.23, ram: 15 })
  await history.record({ time: now + 10_000, cpu: 7, ram: 15 })
  now = midnight + 10_000
  await history.record({ time: now, cpu: null, ram: 19 })
  now += minute
  await history.record({ time: now, cpu: null, ram: null })

  const restored = await openMetricHistory(directory, () => now)
  const samples = [{ time: midnight - minute * 2, cpu: 1.23, ram: 15 }, { time: midnight, cpu: null, ram: 19 }]
  assert.deepEqual(restored.read(1), { at: now, samples, partial: false })
  now = midnight + 2 * hour
  assert.deepEqual(restored.read(1).samples, [])
  assert.deepEqual(restored.read(6).samples, samples)
})

test('uszkodzona godzina pozostawia pozostałe zapisy, a retencja jest ograniczona', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-metric-history-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let now = midnight
  const history = await openMetricHistory(directory, () => now)
  for (let elapsed = 0; elapsed < 28; elapsed++) {
    now = midnight + elapsed * hour
    await history.record({ time: now, cpu: elapsed, ram: 50 })
  }
  assert.equal((await readdir(directory)).length, 25)
  const slot = Math.floor(now / hour - 2) % 25
  await writeFile(join(directory, 'hour-' + slot + '.json'), 'invalid')
  const restored = await openMetricHistory(directory, () => now)
  assert.deepEqual(restored.read(1).samples.map(({ cpu }) => cpu), [26, 27])
  assert.equal(restored.read(1).partial, false)
  assert.deepEqual(restored.read(24).samples.map(({ cpu }) => cpu),
    Array.from({ length: 25 }, (_, index) => index + 3).filter((value) => value !== 25))
  assert.equal(restored.read(24).partial, true)
})
