import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeTickMetricsSource, parseTickMetrics } from './tick-metrics.mjs'

const body = `# TYPE minecraft_tps gauge
minecraft_tps 19.82
# TYPE minecraft_mspt gauge
minecraft_mspt{type="min",} 1.2
minecraft_mspt{type="mean",} 1.26e+1
minecraft_mspt{type="max",} 110.25
minecraft_players_online{namespace="minecraft",} 4.0
`

test('czyta TPS oraz średni MSPT z formatu FabricExporter 1.0.20', () => {
  assert.deepEqual(parseTickMetrics(body), { tps: 19.82, mspt: 12.6 })
  assert.deepEqual(parseTickMetrics(body.replaceAll(',}', '}')), { tps: 19.82, mspt: 12.6 })
  assert.deepEqual(parseTickMetrics(body.replace('19.82', '30.0')), { tps: 30, mspt: 12.6 })
  assert.throws(() => parseTickMetrics(body.replace('1.26e+1', '0.0')), /Missing measured/)
  assert.throws(() => parseTickMetrics(body.replace('19.82', 'NaN')), /Invalid tick metric/)
  assert.throws(() => parseTickMetrics(body + 'minecraft_tps 20.0\n'), /Invalid tick metric/)
  assert.throws(() => parseTickMetrics(body + 'minecraft_mspt{type="mean"} 10.0\n'), /Invalid tick metric/)
})

test('używa lokalnego eksportera i ogranicza odpowiedzi do tekstu oraz określonego rozmiaru', async () => {
  assert.equal(makeTickMetricsSource(undefined), null)
  assert.throws(() => makeTickMetricsSource('http://somewhere.test'))
  const source = makeTickMetricsSource('25585', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:25585/metrics')
    assert.equal(options.redirect, 'error')
    return new Response(body)
  })
  assert.deepEqual(await source(), { tps: 19.82, mspt: 12.6 })
  await assert.rejects(makeTickMetricsSource('25585', async () => Response.json({ tps: 20, mspt: 12 }))(), /Invalid FabricExporter/)
  await assert.rejects(makeTickMetricsSource('25585', async () => new Response(' '.repeat(128 * 1024 + 1)))(), /too large/)
})
