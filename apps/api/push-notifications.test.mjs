import assert from 'node:assert/strict'
import { createECDH, createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import ece from 'http_ece'
import { normalizePushSubscription, openPushNotifications, trackGameStatus } from './push-notifications.mjs'

test('publikuje dopiero potwierdzoną zmianę stanu procesu lub powrót gry', () => {
  const observe = trackGameStatus()
  const online = { running: true, reachable: true }
  const offline = { running: false, reachable: false }
  const noPing = { running: true, reachable: false }
  assert.deepEqual([online, online, offline, null, offline, noPing].map(observe), [null, null, null, null, null, null])
  assert.deepEqual([offline, offline, offline, noPing, online, online, online].map(observe),
    [null, 'offline', null, null, null, 'online', null])
})

test('szyfruje powiadomienia do urządzenia z zapisaną zgodą i blokuje inne konto', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcc-push-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const origin = 'https://mcc.example.test'
  const privateKey = createECDH('prime256v1')
  privateKey.generateKeys()
  const authSecret = randomBytes(16)
  const endpoint = 'https://web.push.apple.com/example-device'
  const subscription = { endpoint, keys: { p256dh: privateKey.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } }
  const deviceId = createHash('sha256').update(endpoint).digest('hex')
  assert.deepEqual(normalizePushSubscription(subscription), subscription)
  for (const bad of ['https://web.push.apple.com.evil.test/device', 'https://web.push.apple.com@127.0.0.1/device',
    'https://web.push.apple.com:444/device', 'http://web.push.apple.com/device', 'https://web.push.apple.com/device#suffix']) {
    assert.equal(normalizePushSubscription({ ...subscription, endpoint: bad }), null)
  }
  assert.equal(normalizePushSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'invalid' } }), null)

  let when = Date.now()
  const recipient = { username: 'owner', revision: randomBytes(16).toString('base64url') }
  const other = { username: 'other', revision: randomBytes(16).toString('base64url') }
  const active = new Map([[recipient.username, recipient], [other.username, other]])
  const delivered = []
  let providerStatus = 201
  const options = { root, origin, subject: 'mailto:owner@example.test', accounts: () => active, now: () => when,
    send: async (url, init) => {
      assert.equal(url, endpoint)
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      const headers = new Headers(init.headers)
      assert.match(headers.get('authorization'), /^vapid t=/)
      assert.equal(headers.get('content-encoding'), 'aes128gcm')
      const decoded = JSON.parse(ece.decrypt(init.body, { version: 'aes128gcm', privateKey, authSecret }).toString())
      delivered.push({ decoded, authorization: headers.get('authorization') })
      return new Response(null, { status: providerStatus })
    },
  }
  const push = await openPushNotifications(options)
  assert.equal(await push.action(recipient, { action: 'enable', subscription }), 200)
  assert.equal(await push.action(other, { action: 'enable', subscription }), 409)
  assert.equal(await push.action(other, { action: 'test', id: deviceId }), 404)
  assert.deepEqual(push.state(other).deviceIds, [])
  const restarted = await openPushNotifications(options)
  assert.deepEqual(restarted.state(recipient), { enabled: true, publicKey: push.state(recipient).publicKey, deviceIds: [deviceId] })
  assert.equal(await restarted.action(recipient, { action: 'test', id: deviceId }), 200)
  assert.equal(await restarted.action(recipient, { action: 'test', id: deviceId }), 429)
  await restarted.broadcast('offline')
  assert.deepEqual(delivered.map(({ decoded }) => [decoded.web_push, decoded.notification.tag, decoded.notification.body]), [
    [8030, 'mcc-test', 'To jest próbne powiadomienie MCC.'],
    [8030, 'mcc-status', 'Serwer Minecraft został zatrzymany.'],
  ])
  assert.equal(delivered[0].authorization, delivered[1].authorization)
  assert.equal(delivered[0].decoded.notification.navigate, origin + '/?mode=live#observatory/overview')
  active.delete(recipient.username)
  await restarted.broadcast('online')
  assert.equal(delivered.length, 2)
  active.set(recipient.username, recipient)
  providerStatus = 410
  when += 65_000
  assert.equal(await restarted.action(recipient, { action: 'test', id: deviceId }), 410)
  assert.deepEqual(restarted.state(recipient).deviceIds, [])
})
