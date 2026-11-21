import { createECDH, createHash, ECDH } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateRequestDetails, generateVAPIDKeys, getVapidHeaders } from 'web-push'
import { validName } from './accounts.mjs'
import { writeJson } from './json-store.mjs'

const maxDevices = 20
const maxPerAccount = 4
const minute = 60_000
const overview = '/?mode=live#observatory/overview'
const messages = {
  online: 'Serwer Minecraft jest dostępny.',
  offline: 'Serwer Minecraft został zatrzymany.',
  test: 'To jest próbne powiadomienie MCC.',
}
const appleOrigin = 'https://web.push.apple.com'
const hash = (text) => createHash('sha256').update(text).digest('hex')
const idPattern = /^[a-f0-9]{64}$/

function decode(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  const buffer = Buffer.from(value, 'base64url')
  return buffer.length === bytes && buffer.toString('base64url') === value ? buffer : null
}

export function normalizePushSubscription(value) {
  const endpoint = value?.endpoint
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return null
  const url = URL.parse(endpoint)
  if (!url || url.origin !== appleOrigin || url.username || url.password || url.hash
    || url.href !== endpoint || url.pathname === '/') return null
  const { auth, p256dh } = value.keys ?? {}
  const point = decode(p256dh, 65)
  if (!decode(auth, 16) || point?.[0] !== 4) return null
  try {
    ECDH.convertKey(point, 'prime256v1')
    return { endpoint, keys: { auth, p256dh } }
  } catch {
    return null
  }
}

function validVapid(value) {
  const secret = decode(value?.privateKey, 32)
  if (!secret || !decode(value.publicKey, 65)) return false
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(secret)
    return ecdh.getPublicKey().toString('base64url') === value.publicKey
  } catch {
    return false
  }
}

// Start with a baseline and require consecutive confirmed states. Lost polls and
// an unresponsive game ping cannot by themselves confirm that the process stopped.
export function trackGameStatus() {
  let stable = null
  let candidate = null
  return (snapshot) => {
    const observed = snapshot?.running === false ? 'offline' : snapshot?.running && snapshot.reachable ? 'online' : null
    if (observed === null || stable === observed) {
      candidate = null
      return null
    }
    if (observed !== candidate) {
      candidate = observed
      return null
    }
    const change = stable === null ? null : observed
    stable = observed
    candidate = null
    return change
  }
}

export async function openPushNotifications({ root, origin, subject, accounts, send = fetch, now = Date.now }) {
  if (!origin || !subject) return null
  if (typeof subject !== 'string' || !/^mailto:[^@\s?#]+@[^@\s?#]+\.[^@\s?#]+$/.test(subject) || subject.length > 254) {
    throw new Error('Invalid VAPID contact')
  }
  const directory = join(root, hash(origin))
  const file = join(directory, 'devices.json')
  let vapid
  let devices = new Map()
  try {
    if ((await stat(file)).size > 65_536) throw new Error('Oversized Web Push store')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    if (!validVapid(saved?.vapid) || !Array.isArray(saved.devices) || saved.devices.length > maxDevices) {
      throw new Error('Invalid Web Push store')
    }
    vapid = saved.vapid
    for (const entry of saved.devices) {
      const subscription = normalizePushSubscription(entry?.subscription)
      if (!subscription || !validName(entry.username) || !decode(entry.revision, 16)) throw new Error('Invalid Web Push device')
      const id = hash(subscription.endpoint)
      if (devices.has(id)) throw new Error('Duplicate Web Push device')
      devices.set(id, { subscription, username: entry.username, revision: entry.revision })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await mkdir(directory, { recursive: true, mode: 0o700 })
    vapid = generateVAPIDKeys()
    await writeFile(file, JSON.stringify({ vapid, devices: [] }), { flag: 'wx', mode: 0o600, flush: true })
  }

  let operations = Promise.resolve()
  function modify(change) {
    const result = operations.then(async () => {
      const next = new Map(devices)
      const status = change(next)
      if (status !== 200) return status
      await writeJson(file, { vapid, devices: [...next.values()] }, { durable: true })
      devices = next
      return status
    })
    operations = result.catch(() => {})
    return result
  }

  let authorization
  let refreshAt = 0
  async function deliver(id, device, kind) {
    if (devices.get(id) !== device) return 410
    const when = now()
    if (!authorization || when >= refreshAt) {
      const expires = Math.floor(when / 1000) + 7200
      authorization = getVapidHeaders(appleOrigin, subject, vapid.publicKey, vapid.privateKey, 'aes128gcm', expires)
      refreshAt = when + 90 * minute
    }
    const test = kind === 'test'
    const tag = test ? 'mcc-test' : 'mcc-status'
    const payload = JSON.stringify({ web_push: 8030, notification: {
      title: 'Minecraft Control Center', lang: 'pl', body: messages[kind], tag, navigate: new URL(overview, origin).href,
    } })
    const request = generateRequestDetails(device.subscription, payload, {
      headers: authorization, TTL: test ? 60 : 300, topic: tag, urgency: test ? 'high' : 'normal', contentEncoding: 'aes128gcm',
    })
    const response = await send(request.endpoint, {
      method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(6000),
    })
    await response.body?.cancel()
    if (response.status === 404 || response.status === 410) {
      await modify((next) => next.get(id) === device && next.delete(id) ? 200 : 204)
      return 410
    }
    return response.ok ? 200 : 502
  }

  const testAt = new Map()
  const owned = (device, account) => device?.username === account.username && device.revision === account.revision
  let notifying = false
  let queuedStatus = null
  return {
    state(account) {
      return { enabled: true, publicKey: vapid.publicKey,
        deviceIds: [...devices].filter(([, device]) => owned(device, account)).map(([id]) => id) }
    },
    async action(account, input) {
      const action = input?.action
      if (action === 'enable') {
        const subscription = normalizePushSubscription(input.subscription)
        if (!subscription) return 400
        const id = hash(subscription.endpoint)
        const active = await accounts()
        if (active.get(account.username)?.revision !== account.revision) return 401
        return modify((next) => {
          for (const [key, device] of next) if (active.get(device.username)?.revision !== device.revision) next.delete(key)
          const previous = next.get(id)
          if (previous && !owned(previous, account)) return 409
          if (!previous && (next.size >= maxDevices || [...next.values()].filter((device) => owned(device, account)).length >= maxPerAccount)) return 429
          next.set(id, { username: account.username, revision: account.revision, subscription })
          return 200
        })
      }
      if (action === 'clear') return modify((next) => {
        for (const [id, device] of next) if (owned(device, account)) next.delete(id)
        return 200
      })
      const id = input?.id
      if (typeof id !== 'string' || !idPattern.test(id) || (action !== 'disable' && action !== 'test')) return 400
      if (action === 'disable') return modify((next) => owned(next.get(id), account) && next.delete(id) ? 200 : 404)
      const device = devices.get(id)
      if (!owned(device, account)) return 404
      const when = now()
      for (const [name, expires] of testAt) if (expires <= when) testAt.delete(name)
      if (testAt.has(account.username)) return 429
      if ((await accounts()).get(account.username)?.revision !== account.revision) return 401
      if (testAt.has(account.username)) return 429
      testAt.set(account.username, when + minute)
      return deliver(id, device, 'test').catch(() => 502)
    },
    async broadcast(status) {
      queuedStatus = status
      if (notifying) return
      notifying = true
      try {
        while (queuedStatus) {
          const kind = queuedStatus
          queuedStatus = null
          if (!devices.size) continue
          const active = await accounts()
          const subscribed = [...devices].filter(([, device]) => active.get(device.username)?.revision === device.revision)
          await Promise.allSettled(subscribed.map(([id, device]) => deliver(id, device, kind)))
        }
      } finally {
        notifying = false
      }
    },
  }
}
