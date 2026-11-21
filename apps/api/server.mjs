import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { apiPort, configPath, loadCraftyConfig } from './config.mjs'
import { makeCraftyClient } from './crafty.mjs'
import { loadAccounts, validName, validPassword, verifyPassword } from './accounts.mjs'
import { createSessions, sessionInfo, validCsrf } from './sessions.mjs'
import { createPowerJournal, makePowerController, validPowerRequest } from './power.mjs'
import { makeMapStore } from './map-store.mjs'
import { makePositionSource } from './squaremap.mjs'
import { makeTickMetricsSource } from './tick-metrics.mjs'
import { openMetricHistory } from './metric-history.mjs'
import { openPushNotifications, trackGameStatus } from './push-notifications.mjs'
import { makeEventStore, mergeWorldActivity, observedEvents } from './world-events.mjs'
import { makeFabricEventSource } from './fabric-events.mjs'
import { makeWaypointStore, normalizeWaypoint, validWaypointId } from './waypoints.mjs'
import { makeBackupStore, validArchiveId } from './backup-store.mjs'
import { makeCraftyArchiveStore } from './crafty-archive.mjs'
import { makeBackupJobs } from './backup-jobs.mjs'
import { makeWorldRestore } from './world-restore.mjs'
import { makeCommandService } from './game-command.mjs'
import { makeLivePlayerSource, readPlayerDirectory, readSavedBossEvents } from './player-directory.mjs'
import { makePlayerInventoryStore, playerUuid } from './player-inventory.mjs'
import { FileOperationError, makeFileManager } from './file-manager.mjs'
import { makeModStaging, maxModBytes } from './fabric-mod.mjs'
import { makeModLifecycle } from './mod-lifecycle.mjs'
import { parseServerFileGroup } from './server-file-access.mjs'
import { makePrivateSite, parsePrivateOrigin, parseSshCraftyOrigin, parseSshOrigin, requestAllowed } from './private-site.mjs'

const identity = (value) => value
function feed({ initial, read, delay, idleDelay, update }) {
  const clients = new Map()
  let value = initial
  let lastRequest = -Infinity
  let pending = false
  let timer

  function send(response, payload) {
    if (response.writableLength > 1_000_000) response.destroy()
    else response.write('data: ' + payload + '\n\n')
  }

  async function poll() {
    const cadence = clients.size ? delay : idleDelay
    const started = performance.now()
    if (!cadence || pending || started - lastRequest < cadence - 30) return
    pending = true
    lastRequest = started
    try {
      value = { ...await update(value, await read(clients.size > 0)), health: 'ok', updatedAt: Date.now() }
    } catch {
      value = { ...value, health: 'error', checkedAt: Date.now() }
    } finally {
      pending = false
    }
    const payloads = new Map()
    for (const [client, select] of clients) {
      if (!payloads.has(select)) payloads.set(select, JSON.stringify(select(value)))
      send(client, payloads.get(select))
    }
  }

  function stop() {
    clearInterval(timer)
  }

  function schedule() {
    stop()
    const cadence = clients.size ? delay : idleDelay
    if (cadence) {
      void poll()
      timer = setInterval(() => void poll(), cadence)
      timer.unref()
    }
  }

  function subscribe(response, session, select = identity) {
    if (clients.size >= 24) {
      response.writeHead(503).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
    response.write('retry: 2500\n\n')
    clients.set(response, select)
    const closeRevoked = () => response.end()
    session.listeners.add(closeRevoked)
    response.once('close', () => {
      session.listeners.delete(closeRevoked)
      clients.delete(response)
      if (!clients.size) schedule()
    })
    const expired = value.health === 'ok' && Date.now() - value.updatedAt > delay * 2
    send(response, JSON.stringify(select(expired ? { ...value, health: 'loading' } : value)))
    if (clients.size === 1) schedule()
  }

  return { subscribe, schedule, stop }
}

let config
try {
  config = loadCraftyConfig()
} catch {
  console.error('MCC: nie można wczytać lokalnej konfiguracji Crafty.')
  process.exit(1)
}

const privateOrigin = parsePrivateOrigin(process.env.MCC_PRIVATE_ORIGIN)
const sshOrigin = parseSshOrigin(process.env.MCC_SSH_ORIGIN)
if (privateOrigin && sshOrigin) throw new Error('Configure only one MCC browser origin')
const panelOrigin = privateOrigin ?? sshOrigin
const client = makeCraftyClient(config)
const worldMap = makeMapStore(join(dirname(configPath), 'map-work', 'published'))
const readPlayerInventory = makePlayerInventoryStore()
let readPositions = null
try {
  readPositions = makePositionSource(process.env.MCC_SQUAREMAP_PORT)
} catch {
  console.error('MCC: nieprawidłowy lokalny port squaremap.')
}
const subscribePositions = readPositions ? feed({ initial: { health: 'loading', positions: [], updatedAt: 0 },
  read: readPositions, delay: 2500, update: (_old, positions) => ({ positions }) }).subscribe : null
const currentPositions = ({ health, positions, updatedAt }) => ({ health, positions: health === 'ok' ? positions : [], updatedAt })
const sharedWaypoints = process.env.MCC_WAYPOINTS_FILE
const waypoints = makeWaypointStore(sharedWaypoints || join(dirname(configPath), 'world-waypoints.json'), {
  groupReadable: Boolean(sharedWaypoints),
})
const backups = makeBackupStore(join(dirname(configPath), 'recovery', 'archives'))
const eventStore = makeEventStore()
let readFabricEvents
try {
  readFabricEvents = makeFabricEventSource(process.env.MCC_WORLD_EVENTS_ROOT)
} catch {
  console.error('MCC: nieprawidłowy katalog zdarzeń Fabric.')
}
const disabledFabric = { status: 'disabled', events: [], deaths: [], skipped: 0 }
const subscribeDeaths = readFabricEvents ? feed({
  initial: { health: 'loading', updatedAt: null, status: 'waiting', positions: [] },
  delay: 5000,
  read: readFabricEvents,
  update: (_old, { status, deaths }) => ({ status, positions: deaths }),
}).subscribe : null
let archiveUnavailable = false
const archivedEvents = await eventStore.read().catch(() => {
  archiveUnavailable = true
  return []
})
let power = null
if (config.controlToken) {
  try {
    const journal = await createPowerJournal(join(dirname(configPath), 'power-journal.json'))
    power = makePowerController({ journal, read: client.stats, write: client.action })
  } catch {
    console.error('MCC: nie można otworzyć dziennika sterowania.')
  }
}
let gameCommands = null
if (config.commandToken || config.listToken) {
  try {
    gameCommands = await makeCommandService({ file: join(dirname(configPath), 'command-journal.json'), send: client.command,
      mode: config.listToken ? 'list' : 'manage' })
  } catch {
    console.error('MCC: nie można otworzyć dziennika komend.')
  }
}
let backupJobs = null
const fileGroupId = parseServerFileGroup(process.env.MCC_SERVER_FILES_GID)
const readLivePlayers = makeLivePlayerSource(process.env.MCC_SERVER_FILES_ROOT)
const files = makeFileManager({
  root: process.env.MCC_SERVER_FILES_ROOT,
  journal: join(dirname(configPath), 'server-file-history.json'),
  allowWrites: process.env.MCC_ENABLE_FILE_CHANGES === '1',
  groupId: fileGroupId,
  readRunning: async () => (await client.stats()).running,
  otherOperation: () => power?.busy || power?.publicState().operation?.status === 'uncertain' || gameCommands?.busy || backupJobs?.busy,
})
if (config.backupToken && process.env.MCC_CRAFTY_BACKUP_ROOT) {
  try {
    const world = process.env.MCC_CRAFTY_WORLD_FOLDER ?? 'world'
    const readRunning = async () => (await client.stats()).running
    const archives = makeCraftyArchiveStore({ directory: process.env.MCC_CRAFTY_BACKUP_ROOT,
      backupId: config.backupId, world })
    const groupId = parseServerFileGroup(process.env.MCC_WORLD_RESTORE_GID) ?? fileGroupId
    const worldRestore = process.env.MCC_ENABLE_FILE_CHANGES === '1' && process.env.MCC_SERVER_FILES_ROOT
      ? makeWorldRestore({ root: process.env.MCC_SERVER_FILES_ROOT, world, archives, readRunning, groupId }) : null
    backupJobs = await makeBackupJobs({
      file: join(dirname(configPath), 'crafty-backup-jobs.json'), client, archives, readRunning, worldRestore,
      otherOperation: () => files.busy || power?.busy || power?.publicState().operation?.status === 'uncertain' || gameCommands?.busy,
    })
  } catch {
    console.error('MCC: nie można włączyć zadań kopii przy obecnej konfiguracji.')
  }
}
const backupTimer = backupJobs && setInterval(() => void backupJobs.tick().catch(() => {}), 12_000)
backupTimer?.unref()
const modVersions = {
  minecraft: process.env.MCC_FILES_MINECRAFT_VERSION ?? '1.21.11',
  fabricloader: process.env.MCC_FILES_FABRIC_VERSION ?? '0.19.5',
  java: process.env.MCC_FILES_JAVA_VERSION ?? '25',
}
const stagedMods = makeModStaging({ directory: join(dirname(configPath), 'staged-mods'), versions: modVersions })
const modLifecycle = makeModLifecycle({
  files, staging: stagedMods, versions: modVersions, groupId: fileGroupId, journal: join(dirname(configPath), 'mod-history'),
})
let uploadPending = false
let readTickMetrics = null
try {
  readTickMetrics = makeTickMetricsSource(process.env.MCC_FABRIC_EXPORTER_PORT)
} catch {
  console.error('MCC: nieprawidłowy lokalny port FabricExporter.')
}
const metricHistory = await openMetricHistory(join(dirname(configPath), 'metric-history', config.serverId.toLowerCase()))
const notifications = await openPushNotifications({
  root: join(dirname(configPath), 'web-push'), origin: privateOrigin?.origin,
  subject: process.env.MCC_WEB_PUSH_SUBJECT, accounts: loadAccounts,
}).catch(() => {
  console.error('MCC: nie można włączyć powiadomień Web Push.')
  return null
})
const observeGame = trackGameStatus()
const statsFeed = feed({
  initial: { health: 'loading', updatedAt: null, name: config.name, snapshot: null, tickMetricsEnabled: Boolean(readTickMetrics) },
  async read(observed) {
    const snapshot = await client.stats().catch((error) => {
      observeGame(null)
      throw error
    })
    if (notifications) {
      const change = observeGame(snapshot)
      if (change) void notifications.broadcast(change).catch(() => {})
    }
    const tickMetrics = observed && readTickMetrics && snapshot.reachable && snapshot.online > 0
      ? await readTickMetrics().catch(() => null) : null
    return { ...snapshot, tickMetrics }
  },
  delay: 10_000,
  idleDelay: 60_000,
  async update(state, snapshot) {
    await metricHistory.record(snapshot)
    return { ...state, snapshot }
  },
})
const logFeed = feed({
  initial: { health: 'loading', updatedAt: null, lines: [], loggedAt: null, events: archivedEvents,
    logHealth: 'loading', bosses: await readSavedBossEvents().catch(() => []), archiveUnavailable, unsavedEvents: [],
    fabric: readFabricEvents ? { ...disabledFabric, status: 'waiting' } : disabledFabric },
  async read(observed) {
    const [logResult, fabricResult] = await Promise.allSettled([client.logs(), observed ? readFabricEvents?.() : undefined])
    return { logResult, fabricResult, observed }
  },
  delay: 5000,
  idleDelay: 60_000,
  async update(state, { logResult, fabricResult, observed }) {
    const next = { ...state }
    if (observed) {
      next.bosses = await readSavedBossEvents().catch(() => state.bosses)
      next.fabric = fabricResult.status === 'fulfilled' ? fabricResult.value ?? disabledFabric : { ...state.fabric, status: 'error' }
    }
    let unsavedEvents = state.unsavedEvents
    if (logResult.status === 'fulfilled') {
      const lines = logResult.value
      const loggedAt = Date.now()
      const detected = observedEvents(state.loggedAt === null ? null : state.lines, lines, state.loggedAt, loggedAt)
      unsavedEvents = [...unsavedEvents, ...detected].slice(-300)
      Object.assign(next, { lines, loggedAt, logHealth: 'ok' })
    } else {
      next.logHealth = 'error'
    }
    try {
      if (unsavedEvents.length) next.events = await eventStore.append(unsavedEvents)
      else if (state.archiveUnavailable) next.events = await eventStore.read()
      return { ...next, archiveUnavailable: false, unsavedEvents: [] }
    } catch {
      return { ...next, archiveUnavailable: true, unsavedEvents }
    }
  },
})

const logConnection = ({ health, logHealth, loggedAt }) => ({ health: health === 'ok' ? logHealth : health, updatedAt: loggedAt })
const onlyLogs = (state) => ({ ...logConnection(state), lines: state.lines })
function activityPayload(state, locations) {
  const { events, bosses, fabric, archiveUnavailable } = state
  const merged = mergeWorldActivity(events, bosses, fabric.events).map(({ uuid, location, ...event }) =>
    locations && location ? { ...event, location } : event)
  return { ...logConnection(state), events: merged, archiveUnavailable, fabricStatus: fabric.status, fabricSkipped: fabric.skipped }
}
const onlyActivity = (state) => activityPayload(state, false)
const operatorActivity = (state) => activityPayload(state, true)

const localOrigins = new Set(['http://127.0.0.1:5173', 'http://127.0.0.1:4173'])
const craftyBrowserOrigin = sshOrigin ? parseSshCraftyOrigin(process.env.MCC_SSH_CRAFTY_ORIGIN) : privateOrigin ? null : config.address
const craftyTerminal = craftyBrowserOrigin ? new URL('/panel/server_detail', craftyBrowserOrigin) : null
craftyTerminal?.searchParams.set('id', config.serverId)
craftyTerminal?.searchParams.set('subpage', 'term')
const operatorStats = (value) => ({ ...value, craftyTerminal: craftyTerminal.href })
const origins = panelOrigin ? new Set([panelOrigin.origin]) : localOrigins
const staticSite = panelOrigin ? await makePrivateSite(fileURLToPath(new URL('../../dist/', import.meta.url)), { https: Boolean(privateOrigin) }) : null
const sessions = createSessions(Date.now, sshOrigin ? 'mcc_ssh_session' : undefined)
let concurrentLogins = 0
let failedLogins = []

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let length = 0
  for await (const part of request) {
    length += part.length
    if (length > 4096) throw new Error('Request too large')
    chunks.push(part)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function login(request, response, previous) {
  failedLogins = failedLogins.filter((time) => Date.now() - time < 60_000)
  if (failedLogins.length >= 6 || concurrentLogins >= 2) {
    response.setHeader('Retry-After', '60')
    reply(response, 429, { error: 'limit' })
    return
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    reply(response, 415, { error: 'format' })
    return
  }
  concurrentLogins++
  try {
    let input
    try {
      input = await readJson(request)
    } catch {
      if (!response.destroyed) reply(response, 400, { error: 'format' })
      return
    }
    const username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : ''
    const accounts = await loadAccounts()
    if (accounts.size === 0) {
      reply(response, 503, { error: 'setup' })
      return
    }
    const account = validName(username) ? accounts.get(username) : undefined
    if (!validPassword(input?.password) || !(await verifyPassword(input.password, account))
      || (await loadAccounts()).get(username)?.revision !== account.revision) {
      failedLogins.push(Date.now())
      reply(response, 401, { error: 'credentials' })
      return
    }
    failedLogins = []
    sessions.revoke(previous)
    const session = sessions.create(account)
    response.setHeader('Set-Cookie', sessions.cookie(session, Boolean(privateOrigin)))
    reply(response, 200, { account: sessionInfo(session) })
  } catch {
    if (!response.destroyed) reply(response, 503, { error: 'unavailable' })
  } finally {
    concurrentLogins--
  }
}

const accountUpdates = setInterval(async () => {
  try {
    sessions.reconcile(await loadAccounts())
  } catch {
    sessions.reconcile(new Map())
  }
}, 3000)
accountUpdates.unref()

async function notificationsEndpoint(request, response, session) {
  if (!session) return reply(response, 401, { error: 'session' })
  if (request.method === 'GET') return reply(response, 200, notifications?.state(session) ?? { enabled: false })
  if (request.method !== 'POST') return response.writeHead(405, { Allow: 'GET, POST' }).end()
  if (!origins.has(request.headers.origin) || !validCsrf(session, request.headers['x-mcc-csrf'])) {
    return reply(response, 403, { error: 'csrf' })
  }
  if (!notifications) return reply(response, 503, { error: 'disabled' })
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    return reply(response, 415, { error: 'format' })
  }
  let input
  try { input = await readJson(request) } catch {
    if (!response.destroyed) reply(response, 400, { error: 'format' })
    return
  }
  try {
    const current = (await loadAccounts()).get(session.username)
    if (sessions.get(request.headers.cookie) !== session || current?.revision !== session.revision) {
      return reply(response, 401, { error: 'session' })
    }
    const status = await notifications.action(session, input)
    return reply(response, status, notifications.state(session))
  } catch {
    if (!response.destroyed) reply(response, 503, { error: 'unavailable' })
  }
}

async function powerEndpoint(request, response, session) {
  if (!session || session.role !== 'operator') {
    reply(response, session ? 403 : 401, { error: 'permission' })
    return
  }
  if (request.method === 'GET') {
    reply(response, 200, power?.publicState() ?? { enabled: false, operation: null })
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'GET, POST' }).end()
    return
  }
  if (!origins.has(request.headers.origin) || !validCsrf(session, request.headers['x-mcc-csrf'])) {
    reply(response, 403, { error: 'csrf' })
    return
  }
  if (!power) {
    reply(response, 503, { error: 'disabled' })
    return
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    reply(response, 415, { error: 'format' })
    return
  }
  try {
    const input = await readJson(request)
    const account = (await loadAccounts()).get(session.username)
    if (sessions.get(request.headers.cookie) !== session || account?.revision !== session.revision) {
      reply(response, 401, { error: 'session' })
      return
    }
    const acknowledge = input?.action === 'acknowledge' && typeof input.id === 'string'
    if (!acknowledge && !validPowerRequest(input)) {
      reply(response, 400, { error: 'format' })
      return
    }
    if (!acknowledge && (gameCommands?.busy || files.busy || backupJobs?.busy)) {
      reply(response, 409, power.publicState())
      return
    }
    const result = acknowledge ? await power.acknowledge(input.id, session.username) : await power.request(input, session.username)
    reply(response, result.status, result.data)
  } catch {
    if (!response.destroyed) reply(response, 400, { error: 'format' })
  }
}

async function commandEndpoint(request, response, session) {
  if (!session || session.role !== 'operator') {
    reply(response, session ? 403 : 401, { error: 'permission' })
    return
  }
  if (request.method === 'GET') {
    reply(response, 200, { enabled: gameCommands?.enabled === true, mode: gameCommands?.enabled ? gameCommands.mode : null })
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'GET, POST' }).end()
    return
  }
  if (!origins.has(request.headers.origin) || !validCsrf(session, request.headers['x-mcc-csrf'])) {
    reply(response, 403, { error: 'csrf' })
    return
  }
  if (!gameCommands?.enabled) {
    reply(response, 503, { error: 'disabled' })
    return
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    reply(response, 415, { error: 'format' })
    return
  }
  let input
  try {
    input = await readJson(request)
  } catch {
    if (!response.destroyed) reply(response, 400, { error: 'format' })
    return
  }
  try {
    const account = (await loadAccounts()).get(session.username)
    if (sessions.get(request.headers.cookie) !== session || account?.revision !== session.revision) {
      reply(response, 401, { error: 'session' })
      return
    }
    if (files.busy || backupJobs?.busy || power?.busy || ['pending', 'uncertain'].includes(power?.publicState().operation?.status)) {
      reply(response, 409, { error: 'power' })
      return
    }
    const result = await gameCommands.execute(input, session.username)
    reply(response, result.status, result.data)
  } catch {
    reply(response, 503, { error: 'storage' })
  }
}

async function backupJobsEndpoint(request, response, session) {
  if (!session || session.role !== 'operator') {
    reply(response, session ? 403 : 401, { error: 'permission' })
    return
  }
  const browser = request.url === '/api/mcc/backup-jobs'
  const listing = request.url === '/api/mcc/backup-jobs/files'
  const name = request.url.match(/^\/api\/mcc\/backup-jobs\/download\/(\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.zip)$/)?.[1]
  const read = request.method === 'GET'
  const change = browser && request.method === 'POST'
  if (!browser && !listing && !name) {
    response.writeHead(404).end()
    return
  }
  if (!read && !change) {
    response.writeHead(405, { Allow: browser ? 'GET, POST' : 'GET' }).end()
    return
  }
  if (read && browser) {
    reply(response, 200, backupJobs?.publicState() ?? { enabled: false, history: [], schedule: null, blocked: false })
    return
  }
  if (!backupJobs) {
    reply(response, 503, { error: 'disabled' })
    return
  }
  try {
    if (read) {
      if (listing) {
        const data = await backupJobs.list()
        if (sessions.get(request.headers.cookie) === session) reply(response, 200, data)
        else reply(response, 401, { error: 'session' })
      } else {
        const file = await backupJobs.download(name)
        await sendArchive(request, response, session, file, name, 'application/zip')
      }
      return
    }
    if (!origins.has(request.headers.origin) || !validCsrf(session, request.headers['x-mcc-csrf'])) {
      reply(response, 403, { error: 'csrf' })
      return
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      reply(response, 415, { error: 'format' })
      return
    }
    const input = await readJson(request).catch(() => { throw new FileOperationError(400, 'format') })
    if (!(await operatorStillActive(request, session))) {
      reply(response, 401, { error: 'session' })
      return
    }
    const result = await backupJobs.request(input, session.username)
    reply(response, result.status, backupJobs.publicState())
  } catch (error) {
    if (response.headersSent) response.destroy()
    else if (!response.destroyed) reply(response, error instanceof FileOperationError ? error.status : 503,
      { error: error instanceof FileOperationError ? error.code : 'backups' })
  }
}

async function operatorStillActive(request, session) {
  const account = (await loadAccounts()).get(session.username)
  return account?.revision === session.revision && account?.role === 'operator' && sessions.get(request.headers.cookie) === session
}

async function uploadedJar(request) {
  const size = Number(request.headers['content-length'])
  if (!Number.isSafeInteger(size)) throw new FileOperationError(411, 'mod-size')
  if (size < 1 || size > maxModBytes) throw new FileOperationError(413, 'mod-size')
  const body = Buffer.alloc(size)
  let consumed = 0
  for await (const chunk of request) {
    if (consumed + chunk.length > size) throw new FileOperationError(413, 'mod-size')
    chunk.copy(body, consumed)
    consumed += chunk.length
  }
  if (consumed !== size) throw new FileOperationError(400, 'mod-size')
  return body
}

async function fileEndpoint(request, response, session) {
  if (!session || session.role !== 'operator') {
    reply(response, session ? 403 : 401, { error: 'permission' })
    return
  }
  const browser = request.url === '/api/mcc/files'
  const staging = request.url === '/api/mcc/files/mods'
  const modActions = request.url === '/api/mcc/files/mod-actions'
  const stagedId = request.url.match(/^\/api\/mcc\/files\/mods\/([a-f0-9]{64})$/)?.[1]
  const checkId = request.url.match(/^\/api\/mcc\/files\/mods\/([a-f0-9]{64})\/check$/)?.[1]
  if (!browser && !staging && !stagedId && !modActions && !checkId) {
    response.writeHead(404).end()
    return
  }
  if (request.method === 'GET' && browser) {
    try {
      const [catalog, staged, modHistory] = await Promise.all([files.info(), stagedMods.list(), modLifecycle.history()])
      if (sessions.get(request.headers.cookie) !== session) reply(response, 401, { error: 'session' })
      else reply(response, 200, { ...catalog, staged, modHistory, versions: modVersions })
    } catch {
      reply(response, 503, { error: 'files' })
    }
    return
  }
  const upload = staging && request.method === 'POST'
  const edit = browser && request.method === 'POST'
  const changeMod = modActions && request.method === 'POST'
  const checkMod = checkId && request.method === 'POST'
  const discard = stagedId && request.method === 'DELETE'
  if (!upload && !edit && !discard && !changeMod && !checkMod) {
    response.writeHead(405, { Allow: browser ? 'GET, POST' : (staging || modActions || checkId) ? 'POST' : 'DELETE' }).end()
    return
  }
  if (!origins.has(request.headers.origin) || !validCsrf(session, request.headers['x-mcc-csrf'])) {
    reply(response, 403, { error: 'csrf' })
    return
  }
  const type = request.headers['content-type'] ?? ''
  if ((upload && type !== 'application/octet-stream') || ((edit || changeMod) && !/^application\/json(?:\s*;|$)/i.test(type))) {
    reply(response, 415, { error: 'format' })
    return
  }
  if (upload && uploadPending) {
    reply(response, 409, { error: 'busy' })
    return
  }
  if (upload) uploadPending = true
  try {
    if (!(await operatorStillActive(request, session))) {
      reply(response, 401, { error: 'session' })
      return
    }
    if (upload) {
      const body = await uploadedJar(request)
      if (!(await operatorStillActive(request, session))) {
        reply(response, 401, { error: 'session' })
        return
      }
      reply(response, 201, { mod: await stagedMods.stage(request.headers['x-mcc-filename'], body) })
    } else if (edit || changeMod) {
      const input = await readJson(request).catch(() => { throw new FileOperationError(400, 'format') })
      if (!(await operatorStillActive(request, session))) {
        reply(response, 401, { error: 'session' })
        return
      }
      const operation = await (changeMod ? modLifecycle : files).change(input, session.username)
      reply(response, 200, { operation })
    } else if (checkMod) {
      const report = await modLifecycle.checkStaged(checkId)
      if (sessions.get(request.headers.cookie) !== session) reply(response, 401, { error: 'session' })
      else reply(response, 200, report)
    } else {
      await stagedMods.discard(stagedId)
      response.writeHead(204).end()
    }
  } catch (error) {
    if (!response.destroyed) reply(response, error instanceof FileOperationError ? error.status : 503,
      { error: error instanceof FileOperationError ? error.code : 'files', details: error instanceof FileOperationError ? error.details : undefined })
  } finally {
    if (upload) uploadPending = false
  }
}

async function mapEndpoint(url, response, session) {
  if (!session) {
    reply(response, 401, { error: 'session' })
    return
  }
  try {
    if (url === '/api/mcc/map') {
      const data = await worldMap.info()
      const operator = session.role === 'operator'
      reply(response, 200, { ...data, livePositions: operator && Boolean(subscribePositions), liveDeaths: operator && Boolean(subscribeDeaths) })
      return
    }
    const tile = await worldMap.tile(url)
    if (tile == null) {
      response.writeHead(tile === null ? 204 : 404).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': tile.byteLength }).end(tile)
  } catch {
    reply(response, 503, { error: 'map' })
  }
}

async function playerDirectoryEndpoint(request, response, session) {
  if (!session) {
    reply(response, 401, { error: 'session' })
    return
  }
  try {
    const directory = await readPlayerDirectory({ operator: session.role === 'operator', readLive: readLivePlayers })
    const positions = session.role === 'operator' && subscribePositions ? { livePositions: true } : {}
    if (sessions.get(request.headers.cookie) === session) reply(response, 200, { ...directory, ...positions })
    else reply(response, 401, { error: 'session' })
  } catch {
    reply(response, 503, { error: 'directory' })
  }
}

async function playerInventoryEndpoint(request, response, session, uuid) {
  if (session?.role !== 'operator') {
    reply(response, session ? 403 : 401, { error: 'permission' })
    return
  }
  try {
    const inventory = await readPlayerInventory(uuid)
    if (sessions.get(request.headers.cookie) !== session) reply(response, 401, { error: 'session' })
    else if (inventory) reply(response, 200, inventory)
    else reply(response, 404, { error: 'inventory' })
  } catch {
    reply(response, 503, { error: 'storage' })
  }
}

async function waypointEndpoint(request, response, session) {
  if (!session) {
    reply(response, 401, { error: 'session' })
    return
  }
  if (request.method === 'GET') {
    try {
      reply(response, 200, { points: await waypoints.read() })
    } catch {
      reply(response, 503, { error: 'storage' })
    }
    return
  }
  if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'DELETE') {
    response.writeHead(405, { Allow: 'GET, POST, PATCH, DELETE' }).end()
    return
  }
  if (session.role !== 'operator') {
    reply(response, 403, { error: 'permission' })
    return
  }
  if (!origins.has(request.headers.origin) || !validCsrf(session, request.headers['x-mcc-csrf'])) {
    reply(response, 403, { error: 'csrf' })
    return
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    reply(response, 415, { error: 'format' })
    return
  }
  let input
  try {
    input = await readJson(request)
  } catch {
    if (!response.destroyed) reply(response, 400, { error: 'format' })
    return
  }
  try {
    const account = (await loadAccounts()).get(session.username)
    if (sessions.get(request.headers.cookie) !== session || account?.revision !== session.revision) {
      reply(response, 401, { error: 'session' })
      return
    }
    if (request.method === 'POST') {
      const location = normalizeWaypoint(input)
      if (!location) {
        reply(response, 400, { error: 'format' })
        return
      }
      const { status, points } = await waypoints.create(location)
      reply(response, status, { points })
    } else if (request.method === 'PATCH' && validWaypointId(input?.id)
      && (input.hologramY === null || Number.isInteger(input.hologramY))) {
      const { status, points } = await waypoints.setHologram(input.id, input.hologramY)
      reply(response, status, { points })
    } else if (request.method === 'DELETE' && validWaypointId(input?.id)) {
      reply(response, 200, { points: await waypoints.remove(input.id) })
    } else {
      reply(response, 400, { error: 'format' })
    }
  } catch {
    reply(response, 503, { error: 'storage' })
  }
}

async function backupEndpoint(request, response, session) {
  if (!session || session.role !== 'operator') {
    reply(response, session ? 403 : 401, { error: 'permission' })
    return
  }
  try {
    const url = request.url
    if (url === '/api/mcc/backups') {
      const records = await backups.list()
      if (sessions.get(request.headers.cookie) === session) reply(response, 200, { backups: records })
      else reply(response, 401, { error: 'session' })
      return
    }
    const id = url.slice('/api/mcc/backups/'.length)
    const file = validArchiveId(id) ? await backups.download(id) : null
    await sendArchive(request, response, session, file, file?.name, 'application/octet-stream')
  } catch {
    if (response.headersSent) response.destroy()
    else reply(response, 503, { error: 'archive' })
  }
}

async function sendArchive(request, response, session, file, name, type) {
  if (!file) {
    response.writeHead(404).end()
    return
  }
  if (response.destroyed || sessions.get(request.headers.cookie) !== session) {
    file.stream.destroy()
    if (!response.destroyed) reply(response, 401, { error: 'session' })
    return
  }
  const revoke = () => file.stream.destroy()
  session.listeners.add(revoke)
  try {
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': file.size,
      'Content-Disposition': 'attachment; filename="' + name + '"' })
    await pipeline(file.stream, response)
  } finally {
    session.listeners.delete(revoke)
  }
}

const server = createServer({ requestTimeout: 90_000, headersTimeout: 10_000 }, (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Cache-Control', 'no-store')
  if (!requestAllowed(request.headers, '127.0.0.1:' + apiPort, privateOrigin, localOrigins, sshOrigin)) {
    response.writeHead(403).end()
    return
  }
  if (staticSite && !request.url.startsWith('/api/')) {
    void staticSite(request, response)
    return
  }
  const session = sessions.get(request.headers.cookie)
  if (request.url === '/api/mcc/notifications') {
    void notificationsEndpoint(request, response, session)
    return
  }
  if (request.url === '/api/mcc/power') {
    void powerEndpoint(request, response, session)
    return
  }
  if (request.url === '/api/mcc/commands') {
    void commandEndpoint(request, response, session)
    return
  }
  if (request.url === '/api/mcc/waypoints') {
    void waypointEndpoint(request, response, session)
    return
  }
  if (request.url === '/api/mcc/backup-jobs' || request.url?.startsWith('/api/mcc/backup-jobs/')) {
    void backupJobsEndpoint(request, response, session)
    return
  }
  if (request.url === '/api/mcc/files' || request.url?.startsWith('/api/mcc/files/')) {
    void fileEndpoint(request, response, session)
    return
  }
  if (request.url === '/api/mcc/session') {
    if (request.method === 'GET') {
      reply(response, 200, { account: sessionInfo(session) })
      return
    }
    if (!origins.has(request.headers.origin)) {
      reply(response, 403, { error: 'origin' })
      return
    }
    if (request.method === 'POST') {
      void login(request, response, session)
      return
    }
    if (request.method === 'DELETE') {
      if (session && !validCsrf(session, request.headers['x-mcc-csrf'])) {
        reply(response, 403, { error: 'csrf' })
        return
      }
      sessions.revoke(session)
      response.writeHead(204, { 'Set-Cookie': sessions.cookie(null, Boolean(privateOrigin)) }).end()
      return
    }
    response.writeHead(405, { Allow: 'GET, POST, DELETE' }).end()
    return
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end()
    return
  }
  if (request.url === '/api/mcc/map' || request.url?.startsWith('/api/mcc/map/')) {
    void mapEndpoint(request.url, response, session)
    return
  }
  if (request.url === '/api/mcc/backups' || request.url?.startsWith('/api/mcc/backups/')) {
    void backupEndpoint(request, response, session)
    return
  }
  if (request.url === '/api/mcc/players') {
    void playerDirectoryEndpoint(request, response, session)
    return
  }
  const inventoryUuid = request.url.match(/^\/api\/mcc\/players\/([^/]+)\/inventory$/)?.[1]
  if (inventoryUuid && playerUuid.test(inventoryUuid)) {
    void playerInventoryEndpoint(request, response, session, inventoryUuid)
    return
  }
  const historyRange = request.url.match(/^\/api\/mcc\/history\/(1|6|24)$/)?.[1]
  if (historyRange) {
    if (!session) reply(response, 401, { error: 'session' })
    else reply(response, 200, metricHistory.read(Number(historyRange)))
    return
  }
  switch (request.url) {
    case '/api/mcc/map-players':
      if (!session || session.role !== 'operator') reply(response, session ? 403 : 401, { error: 'permission' })
      else if (!subscribePositions) reply(response, 503, { error: 'disabled' })
      else subscribePositions(response, session, currentPositions)
      break
    case '/api/mcc/map-deaths':
      if (!session || session.role !== 'operator') reply(response, session ? 403 : 401, { error: 'permission' })
      else if (!subscribeDeaths) reply(response, 503, { error: 'disabled' })
      else subscribeDeaths(response, session)
      break
    case '/api/mcc/stats':
    case '/api/mcc/logs':
    case '/api/mcc/activity':
      if (!session) reply(response, 401, { error: 'session' })
      else if (request.url === '/api/mcc/stats') statsFeed.subscribe(response, session,
        craftyTerminal && session.role === 'operator' ? operatorStats : undefined)
      else if (request.url === '/api/mcc/logs') logFeed.subscribe(response, session, onlyLogs)
      else logFeed.subscribe(response, session, session.role === 'operator' ? operatorActivity : onlyActivity)
      break
    default: response.writeHead(404).end()
  }
})

server.once('close', () => {
  clearInterval(accountUpdates)
  if (backupTimer) clearInterval(backupTimer)
  statsFeed.stop()
  logFeed.stop()
  client.close()
})
server.listen(apiPort, '127.0.0.1', () => {
  console.log('MCC API na 127.0.0.1:' + apiPort)
  statsFeed.schedule()
  logFeed.schedule()
})
