import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccounts, saveAccount, verifyPassword } from './accounts.mjs'
import { createSessions, sessionCookie, sessionInfo, SESSION_TTL, validCsrf } from './sessions.mjs'

test('hasło jest solone, zapis nie zawiera jego treści, a reset odwołuje sesje', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcc-auth-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'accounts.json')
  const password = 'local-test-passphrase'
  await saveAccount('viewer1', 'viewer', password, path)
  await saveAccount('operator1', 'operator', password, path)
  const accounts = await loadAccounts(path)
  const viewer = accounts.get('viewer1')
  const operator = accounts.get('operator1')
  assert.notEqual(viewer.hash, operator.hash)
  assert.equal((await readFile(path, 'utf8')).includes(password), false)
  assert.equal(await verifyPassword(password, viewer), true)
  assert.equal(await verifyPassword(password + 'x', viewer), false)
  assert.equal(await verifyPassword(password, undefined), false)
  const sessions = createSessions()
  const session = sessions.create(viewer)
  let closed = false
  session.listeners.add(() => { closed = true })
  await saveAccount('viewer1', 'viewer', 'different-test-password', path)
  sessions.reconcile(await loadAccounts(path))
  assert.equal(sessions.get(sessionCookie(session)), null)
  assert.equal(closed, true)
})

test('sesja używa oddzielnego tokenu CSRF i wygasa nawet przy istniejącym cookie', () => {
  let time = 100
  const sessions = createSessions(() => time)
  const session = sessions.create({ username: 'operator1', role: 'operator', revision: 'first' })
  const cookie = sessionCookie(session)
  assert.match(cookie, /HttpOnly; SameSite=Strict/)
  assert.equal(sessions.get(cookie), session)
  assert.deepEqual(sessionInfo(session), { username: 'operator1', role: 'operator', csrf: session.csrf })
  assert.equal(validCsrf(session, session.id), false)
  assert.equal(validCsrf(session, session.csrf), true)
  assert.equal(validCsrf(session, ['unexpected']), false)
  time += SESSION_TTL
  assert.equal(sessions.get(cookie), null)
  assert.match(sessionCookie(), /Max-Age=0/)
})
