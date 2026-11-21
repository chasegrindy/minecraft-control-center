const dimensions = new Map([
  ['minecraft_overworld', 'overworld'],
  ['minecraft_the_nether', 'nether'],
  ['minecraft_the_end', 'end'],
])
const maxResponse = 256 * 1024
const maxPlayers = 512
const namePattern = /^[A-Za-z0-9_]{1,16}$/
const uuidPattern = /^[a-f0-9]{32}$/i
const horizontal = (value) => Number.isInteger(value) && Math.abs(value) <= 30_000_000

export function makePositionSource(port, request = fetch) {
  if (!port) return null
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid squaremap port')
  const url = 'http://127.0.0.1:' + Number(port) + '/tiles/players.json'
  return async function readPositions() {
    const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(1500),
      headers: { Accept: 'application/json' } })
    // squaremap 1.3.12 writes a bare timestamp ETag for in-memory data. Its static file handler quotes ETags.
    const live = /^\d+$/.test(response.headers.get('etag') ?? '')
    if (!response.ok || !response.body || !live || Number(response.headers.get('content-length')) > maxResponse) {
      await response.body?.cancel()
      throw new Error('Invalid squaremap response')
    }
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > maxResponse) throw new Error('Squaremap response too large')
      chunks.push(chunk)
    }
    const { players } = JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {}
    if (!Array.isArray(players) || players.length > maxPlayers) throw new Error('Invalid squaremap player list')
    const positions = new Map()
    for (const player of players) {
      if (!player || typeof player.uuid !== 'string' || !uuidPattern.test(player.uuid)
        || typeof player.name !== 'string' || !namePattern.test(player.name)) continue
      const dimension = dimensions.get(player.world)
      if (!dimension || !horizontal(player.x) || !horizontal(player.z)
        || !Number.isInteger(player.y) || Math.abs(player.y) > 20_000_000) continue
      const uuid = player.uuid.toLowerCase()
      positions.set(uuid, { uuid, name: player.name, dimension, x: player.x, y: player.y, z: player.z })
    }
    return [...positions.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}
