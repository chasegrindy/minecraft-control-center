import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const assetTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

const securityHeaders = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; font-src 'self'; img-src 'self' data: blob:; manifest-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
})

export function parsePrivateOrigin(configured) {
  if (!configured) return null
  const url = new URL(configured)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MCC_PRIVATE_ORIGIN must be an HTTPS origin')
  }
  return url
}

function parseLoopbackOrigin(configured, protocol, setting) {
  if (!configured) return null
  const match = /^(https?):\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(configured)
  if (match?.[1] !== protocol || Number(match[2]) > 65535) {
    throw new Error(setting + ' must be an IPv4 loopback ' + protocol.toUpperCase() + ' origin with an explicit port')
  }
  return new URL(configured)
}

export function parseSshOrigin(configured) {
  return parseLoopbackOrigin(configured, 'http', 'MCC_SSH_ORIGIN')
}

export function parseSshCraftyOrigin(configured) {
  return parseLoopbackOrigin(configured, 'https', 'MCC_SSH_CRAFTY_ORIGIN')
}

export function requestAllowed(headers, apiHost, privateOrigin, localOrigins, sshOrigin = null) {
  if (headers['sec-fetch-site'] === 'cross-site') return false
  if (sshOrigin) {
    return headers.host === sshOrigin.host && (!headers.origin || headers.origin === sshOrigin.origin)
      && headers['x-forwarded-host'] === undefined && headers['x-forwarded-proto'] === undefined
      && headers['tailscale-funnel-request'] === undefined
  }
  if (!privateOrigin) return headers.host === apiHost && (!headers.origin || localOrigins.has(headers.origin))
  return (headers.host === apiHost || headers.host === privateOrigin.host)
    && (!headers.origin || headers.origin === privateOrigin.origin)
    && headers['x-forwarded-host'] === privateOrigin.host
    && headers['x-forwarded-proto'] === 'https'
    && headers['tailscale-funnel-request'] === undefined
}

export async function makePrivateSite(directory, { https = true } = {}) {
  const headers = { ...securityHeaders }
  if (!https) delete headers['Strict-Transport-Security']
  const root = await realpath(directory)
  const index = await readFile(join(root, 'index.html'), 'utf8')
  if (!index.includes('<html lang="pl">')) throw new Error('Invalid MCC frontend build')
  const document = Buffer.from(index.replace('<html lang="pl">', '<html lang="pl" data-mcc-private="true">'))
  return async function serve(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    const path = request.url.split('?')[0]
    const asset = path === '/' || path === '/index.html' ? 'index.html' : path.slice(1)
    const bundled = /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css|png|jpg|webp|woff2)$/.test(asset)
    const type = assetTypes[extname(asset)]
    if (!type || (!bundled && !['index.html', 'favicon.png', 'manifest.webmanifest', 'push-worker.js'].includes(asset))) {
      response.writeHead(404).end()
      return
    }
    try {
      let data = document
      if (asset !== 'index.html') {
        const candidate = join(root, asset)
        if (!(await lstat(candidate)).isFile()) throw Object.assign(new Error('Invalid asset'), { code: 'ENOENT' })
        const file = await realpath(candidate)
        if (relative(root, file) !== asset.split('/').join(sep)) throw Object.assign(new Error('Invalid asset path'), { code: 'ENOENT' })
        data = await readFile(file)
      }
      response.writeHead(200, {
        ...headers,
        'Content-Type': type,
        'Content-Length': data.byteLength,
        'Cache-Control': bundled ? 'public, max-age=31536000, immutable' : 'no-cache',
      }).end(request.method === 'GET' ? data : undefined)
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 503).end()
    }
  }
}
