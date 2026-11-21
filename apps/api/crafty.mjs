import { Agent, request as httpsRequest } from 'node:https'
import { stripVTControlCharacters } from 'node:util'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_LOG_LINES = 180
const commands = Object.freeze({ start: 'start_server', stop: 'stop_server', restart: 'restart_server' })
export const isCraftyZip = (name) => typeof name === 'string' && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/.test(name)

export function makeCraftyClient(config, transport = httpsRequest) {
  const agent = new Agent({
    ca: config.certificate,
    keepAlive: true,
    maxSockets: 2,
    checkServerIdentity(_hostname, peerCertificate) {
      if (peerCertificate.fingerprint256 !== config.fingerprint) {
        return new Error('Certificate fingerprint mismatch')
      }
    },
  })

  function call(resource, method, token, command, { raw = false, type = 'text/plain' } = {}) {
    const endpoint = new URL('/api/v2/servers/' + config.serverId + '/' + resource, config.address)
    const body = command === undefined ? undefined : Buffer.from(command, 'utf8')
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    if (body) {
      headers['Content-Type'] = type + '; charset=utf-8'
      headers['Content-Length'] = body.length
    }
    return new Promise((resolve, reject) => {
      const request = transport(endpoint, {
        agent,
        method,
        signal: AbortSignal.timeout(6000),
        headers,
      }, (response) => {
        response.on('error', reject)
        if (response.statusCode !== 200) {
          response.resume()
          const error = new Error('Crafty HTTP ' + response.statusCode)
          error.status = response.statusCode
          reject(error)
          return
        }
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BYTES) {
            response.destroy(new Error('Crafty response exceeded limit'))
          } else {
            chunks.push(chunk)
          }
        })
        response.on('end', () => {
          try {
            const document = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (raw && document && document.status !== 'error') {
              resolve(document)
              return
            }
            if (document.status !== 'ok') {
              const error = new Error('Unexpected Crafty response')
              if (document.status === 'error' && document.error === 'SERVER_NOT_RUNNING') error.code = document.error
              throw error
            }
            resolve(document.data)
          } catch (error) {
            reject(error)
          }
        })
      })
      request.on('error', reject)
      request.end(body)
    })
  }

  function forBackup() {
    if (!config.backupToken || !config.backupId) throw new Error('Crafty backup is unavailable')
    return 'backups/backup/' + config.backupId
  }

  return {
    stats: async () => normalizeStats(await call('stats', 'GET', config.token)),
    logs: async () => normalizeLogs(await call('logs?file=true&raw=true', 'GET', config.token)),
    action(kind) {
      if (!config.controlToken || !Object.hasOwn(commands, kind)) throw new Error('Crafty action is unavailable')
      return call('action/' + commands[kind], 'POST', config.controlToken)
    },
    command(value) {
      const token = config.commandToken ?? (value === 'list' ? config.listToken : null)
      if (!token) throw new Error('Crafty command is unavailable')
      return call('stdin', 'POST', token, value)
    },
    async backupProfile() {
      const value = await call(forBackup(), 'GET', config.backupToken, undefined, { raw: true })
      if (value.backup_id !== config.backupId || value.server_id?.server_id !== config.serverId) throw new Error('Unexpected backup profile')
      const status = JSON.parse(value.status)?.status
      return {
        location: typeof value.backup_location === 'string' ? value.backup_location : null,
        zip: value.backup_type === 'zip_vault',
        enabled: value.enabled === true,
        shutdown: value.shutdown === true,
        hooks: value.before !== '' || value.after !== '',
        keep: Number.isSafeInteger(value.max_backups) && value.max_backups >= 0 ? value.max_backups : null,
        state: status === 'Standby' ? 'ready' : status === 'Failed' ? 'failed' : 'busy',
      }
    },
    async backupFiles() {
      const value = await call(forBackup() + '/files', 'GET', config.backupToken, undefined, { raw: true })
      if (!Array.isArray(value.backups)) throw new Error('Unexpected backup listing')
      return [...new Set(value.backups.filter((file) => typeof file === 'string')
        .map((file) => file.split(/[\\/]/).at(-1)).filter(isCraftyZip))].sort().reverse()
    },
    queueBackup() {
      forBackup()
      return call('action/backup_server/' + config.backupId, 'POST', config.backupToken)
    },
    restoreBackup(filename) {
      if (!isCraftyZip(filename)) throw new Error('Unexpected backup filename')
      return call(forBackup(), 'POST', config.backupToken, JSON.stringify({ filename, inPlace: true }), { type: 'application/json' })
    },
    close: () => agent.destroy(),
  }
}

const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) ? nonnegative(value) : null
}

function dateNumber(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(' ', 'T')
  const timestamp = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : normalized + 'Z')
  return Number.isFinite(timestamp) ? timestamp : null
}

function playerNames(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((entry) => typeof entry === 'string' ? entry : entry?.name)
    .filter((name) => typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name)))].slice(0, 100)
}

export function normalizeStats(value) {
  if (typeof value?.running !== 'boolean') throw new Error('Invalid Crafty stats')
  const running = value.running
  const reachable = running && (value.int_ping_results === true || String(value.int_ping_results).toLowerCase() === 'true')
  return {
    time: Date.now(),
    running,
    reachable,
    startedAt: running ? dateNumber(value.started) : null,
    version: reachable && typeof value.version === 'string' ? value.version.slice(0, 80) : null,
    cpu: nonnegative(value.cpu),
    ram: nonnegative(value.mem_percent),
    memoryBytes: nonnegativeInteger(value.mem_raw) ?? nonnegativeInteger(value.mem),
    online: running ? (reachable ? nonnegativeInteger(value.online) : null) : 0,
    max: reachable ? nonnegativeInteger(value.max) : null,
    players: reachable ? playerNames(value.players) : [],
  }
}

// Crafty raw mode returns literal text. Strip terminal escapes before rendering it in the browser.
const control = new RegExp('[\x00-\x08\x0b-\x1f\x7f]', 'g')

export function normalizeLogs(lines) {
  if (!Array.isArray(lines)) throw new Error('Invalid Crafty logs')
  if (lines.length === 1 && typeof lines[0] === 'string' && lines[0].startsWith('Unable to find file to tail:')) {
    throw new Error('Crafty log file unavailable')
  }
  return lines.slice(-MAX_LOG_LINES).filter((line) => typeof line === 'string')
    .map((line) => stripVTControlCharacters(line).replace(control, '').slice(0, 1800))
}
