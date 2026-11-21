import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makePrivateSite, parsePrivateOrigin, parseSshCraftyOrigin, parseSshOrigin, requestAllowed } from './private-site.mjs'
import { createSessions, sessionCookie } from './sessions.mjs'

const host = '127.0.0.1:4174'
const origin = parsePrivateOrigin('https://mcc.example.ts.net')
const local = new Set(['http://127.0.0.1:5173'])

test('porównuje prywatny HTTPS, odrzuca Funnel i zachowuje dotychczasowy tryb lokalny', () => {
  const routed = { host, 'x-forwarded-host': origin.host, 'x-forwarded-proto': 'https', origin: origin.origin }
  assert.equal(requestAllowed(routed, host, origin, local), true)
  assert.equal(requestAllowed({ ...routed, host: origin.host }, host, origin, local), true)
  for (const headers of [{ host }, { ...routed, 'x-forwarded-proto': 'http' }, { ...routed, host: 'bad.test' },
    { ...routed, origin: 'https://bad.test' }, { ...routed, 'tailscale-funnel-request': '?1' }, { ...routed, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal(requestAllowed(headers, host, origin, local), false)
  }
  assert.equal(requestAllowed({ host, origin: 'http://127.0.0.1:5173' }, host, null, local), true)
  assert.equal(requestAllowed(routed, host, null, local), false)
  assert.throws(() => parsePrivateOrigin('http://mcc.example.ts.net'))
  assert.throws(() => parsePrivateOrigin('https://mcc.example.ts.net/game'))
  assert.match(sessionCookie({ id: 'fixture' }, true), /; Secure$/)
  assert.doesNotMatch(sessionCookie(), /; Secure/)
})

test('obsługuje adres lokalnego tunelu SSH i odrębne cookie sesji', () => {
  const tunnel = parseSshOrigin('http://127.0.0.1:14174')
  const browser = { host: tunnel.host, origin: tunnel.origin }
  const allowed = (headers) => requestAllowed(headers, host, null, local, tunnel)
  assert.equal(allowed(browser), true)
  assert.equal(allowed({ host: tunnel.host }), true)
  for (const headers of [{ ...browser, host }, { ...browser, origin: 'http://127.0.0.1:5173' },
    { ...browser, 'sec-fetch-site': 'cross-site' }, { ...browser, 'x-forwarded-host': tunnel.host },
    { ...browser, 'x-forwarded-proto': 'https' }, { ...browser, 'tailscale-funnel-request': 'true' }]) {
    assert.equal(allowed(headers), false)
  }
  for (const value of ['http://192.168.1.1:14174', 'http://mcc.example:14174', 'https://127.0.0.1:14174',
    'http://127.0.0.1:14174/game', 'http://127.0.0.1:70000']) assert.throws(() => parseSshOrigin(value))
  const sessions = createSessions(Date.now, 'mcc_ssh_session')
  const session = sessions.create({ username: 'operator', role: 'operator' })
  assert.match(sessions.cookie(session), /^mcc_ssh_session=/)
  assert.equal(sessions.get('mcc_session=' + session.id), null)
  assert.equal(sessions.get('mcc_ssh_session=' + session.id), session)
  assert.match(sessions.cookie(), /^mcc_ssh_session=;/)
})

test('skrót do Crafty w trybie SSH dopuszcza tylko wskazany lokalny tunel HTTPS', () => {
  assert.equal(parseSshCraftyOrigin(undefined), null)
  assert.equal(parseSshCraftyOrigin('https://127.0.0.1:18443/').origin, 'https://127.0.0.1:18443')
  for (const value of ['http://127.0.0.1:18443', 'https://127.0.0.1', 'https://127.0.0.1:65536',
    'https://127.1:18443', 'https://192.168.1.10:18443', 'https://localhost:18443', 'https://127.0.0.1:18443@host.test',
    'https://127.0.0.1:18443/panel', 'https://127.0.0.1:18443/?next=external', 'https://127.0.0.1:18443/#console']) {
    assert.throws(() => parseSshCraftyOrigin(value), /MCC_SSH_CRAFTY_ORIGIN/)
  }
})

test('serwuje zbudowany frontend ze ścisłymi nagłówkami i dopuszcza tylko zasoby buildu', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcc-web-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html lang="pl"><body>MCC</body></html>')
  await writeFile(join(root, 'assets', 'index-k0bL2M-N.js'), 'const fixture = true')
  await writeFile(join(root, 'assets', 'private.json'), '{"private":true}')
  await writeFile(join(root, 'push-worker.js'), 'self.addEventListener("push", () => {})')
  const handler = await makePrivateSite(root)

  async function issue(url, method = 'GET') {
    const reply = {
      status: null, headers: {}, body: undefined,
      writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this },
      end(bytes) { this.body = bytes?.toString('utf8') },
    }
    await handler({ url, method }, reply)
    return reply
  }

  const index = await issue('/?mode=live')
  assert.equal(index.status, 200)
  assert.match(index.body, /data-mcc-private="true"/)
  assert.match(index.headers['Content-Security-Policy'], /frame-ancestors 'none'/)
  assert.match(index.headers['Content-Security-Policy'], /worker-src 'self'/)
  assert.equal(index.headers['Cache-Control'], 'no-cache')
  const asset = await issue('/assets/index-k0bL2M-N.js')
  assert.equal(asset.status, 200)
  assert.match(asset.headers['Cache-Control'], /immutable/)
  const worker = await issue('/push-worker.js')
  assert.equal(worker.status, 200)
  assert.match(worker.headers['Content-Type'], /text\/javascript/)
  assert.equal(worker.headers['Cache-Control'], 'no-cache')
  assert.equal((await issue('/index.html', 'HEAD')).body, undefined)
  for (const target of ['/assets/private.json', '/assets/../index.html', '/assets/%2e%2e/index.html', '/crafty.json']) {
    assert.equal((await issue(target)).status, 404)
  }
  assert.equal((await issue('/', 'POST')).status, 405)
})
