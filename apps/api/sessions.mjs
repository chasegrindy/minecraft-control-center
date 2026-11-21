import { randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_TTL = 8 * 60 * 60 * 1000
const COOKIE = 'mcc_session'
const opaque = /^[A-Za-z0-9_-]{43}$/

function cookieId(header = '', cookieName) {
  for (const field of header.split(';')) {
    const [name, id] = field.trim().split('=', 2)
    if (name === cookieName && opaque.test(id)) return id
  }
  return null
}

export function sessionCookie(session = null, secure = false, cookieName = COOKIE) {
  return cookieName + '=' + (session?.id ?? '') + '; Path=/api/mcc; HttpOnly; SameSite=Strict; Max-Age='
    + (session ? SESSION_TTL / 1000 : 0) + (secure ? '; Secure' : '')
}

export function sessionInfo(session) {
  return session ? { username: session.username, role: session.role, csrf: session.csrf } : null
}

export function validCsrf(session, value) {
  return typeof value === 'string' && opaque.test(value)
    && timingSafeEqual(Buffer.from(session.csrf), Buffer.from(value))
}

export function createSessions(now = Date.now, cookieName = COOKIE) {
  const active = new Map()
  function revoke(session) {
    if (!session || !active.delete(session.id)) return
    for (const onRevoke of session.listeners) onRevoke()
    session.listeners.clear()
  }
  return {
    cookie: (session, secure) => sessionCookie(session, secure, cookieName),
    get(header) {
      const session = active.get(cookieId(header, cookieName))
      if (session && session.expiresAt <= now()) {
        revoke(session)
        return null
      }
      return session ?? null
    },
    create(account) {
      for (const session of active.values()) if (session.expiresAt <= now()) revoke(session)
      if (active.size >= 64) revoke(active.values().next().value)
      const session = {
        id: randomBytes(32).toString('base64url'),
        csrf: randomBytes(32).toString('base64url'),
        username: account.username,
        role: account.role,
        revision: account.revision,
        expiresAt: now() + SESSION_TTL,
        listeners: new Set(),
      }
      active.set(session.id, session)
      return session
    },
    revoke,
    reconcile(accounts) {
      for (const session of active.values()) {
        if (session.expiresAt <= now() || accounts.get(session.username)?.revision !== session.revision) revoke(session)
      }
    },
  }
}
