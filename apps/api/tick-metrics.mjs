const bytesLimit = 128 * 1024
const linePattern = /^(minecraft_tps|minecraft_mspt\{type="mean",?\})[\t ]+(\S+)\s*$/
const numberPattern = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export function parseTickMetrics(text) {
  const values = new Map()
  for (const line of text.split('\n')) {
    const match = line.match(linePattern)
    if (!match) continue
    const [, metric, raw] = match
    const name = metric === 'minecraft_tps' ? 'tps' : 'mspt'
    const value = Number(raw)
    if (values.has(name) || !numberPattern.test(raw) || !Number.isFinite(value)) throw new Error('Invalid tick metric')
    values.set(name, value)
  }
  const tps = values.get('tps')
  const mspt = values.get('mspt')
  // FabricExporter publishes zero MSPT before spark has a duration sample.
  if (tps === undefined || !(mspt > 0)) throw new Error('Missing measured tick data')
  return { tps, mspt }
}

export function makeTickMetricsSource(port, request = fetch) {
  if (!port) return null
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid FabricExporter port')
  const url = 'http://127.0.0.1:' + Number(port) + '/metrics'
  return async function readTickMetrics() {
    const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(1500),
      headers: { Accept: 'text/plain' } })
    if (!response.ok || !response.body || !/^text\/plain(?:;|$)/i.test(response.headers.get('content-type') ?? '')
      || Number(response.headers.get('content-length')) > bytesLimit) {
      await response.body?.cancel()
      throw new Error('Invalid FabricExporter response')
    }
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > bytesLimit) throw new Error('FabricExporter response too large')
      chunks.push(chunk)
    }
    return parseTickMetrics(Buffer.concat(chunks).toString('utf8'))
  }
}
