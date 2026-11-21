import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { makeCraftyClient, normalizeLogs, normalizeStats } from './crafty.mjs'

test('normalizuje dane z zainstalowanego Crafty 4.11', () => {
  const stats = normalizeStats({
    running: true, started: '2026-11-18 15:25:26', int_ping_results: 'True',
    version: '1.21.11', cpu: 3.5, mem: 820137984, mem_percent: 7,
    online: 4, max: 20, players: '[{"name":"Astra"},"Astra","Wisp","<b>invalid</b>"]',
  })
  assert.equal(stats.startedAt, Date.parse('2026-11-18T15:25:26Z'))
  assert.equal(stats.memoryBytes, 820137984)
  assert.equal(stats.online, 4)
  assert.deepEqual(stats.players, ['Astra', 'Wisp'])
})

test('brak odpowiedzi z gry różni się od zera i od zatrzymanego procesu', () => {
  const state = { int_ping_results: false, cpu: -1, mem_percent: -1, online: 0, version: '1.21.11' }
  const pingFailed = normalizeStats({ ...state, running: true })
  assert.equal(pingFailed.running, true)
  assert.equal(pingFailed.online, null)
  assert.equal(pingFailed.version, null)
  assert.equal(pingFailed.cpu, null)
  assert.equal(normalizeStats({ ...state, running: false }).online, 0)
  assert.throws(() => normalizeStats({ running: 'true' }))
})

test('zwraca końcówkę logów jako zwykły tekst bez sekwencji terminala', () => {
  const lines = Array.from({ length: 200 }, (_, index) => 'Wpis ' + index)
  lines.push('\u001b[31m<tekst>\u001b[0m', false)
  const result = normalizeLogs(lines)
  assert.equal(result.length, 179)
  assert.equal(result.at(-1), '<tekst>')
  assert.throws(() => normalizeLogs(['Unable to find file to tail: /private/server/logs/latest.log']), /unavailable/)
})

test('dostarcza UTF-8 do udokumentowanego stdin Crafty i obsługuje błąd procesu z HTTP 200', async () => {
  const transmissions = []
  const replies = [{ status: 'ok' }, { status: 'error', error: 'SERVER_NOT_RUNNING' }]
  const serverId = '74159569-204a-4ef3-9e0a-846eb9bd468e'
  const client = makeCraftyClient({ address: 'https://127.0.0.1:18443', serverId, commandToken: 'test-command' },
    (url, options, callback) => {
      const request = new EventEmitter()
      request.end = (body) => {
        transmissions.push({ path: url.pathname, ...options, body })
        queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(JSON.stringify(replies.shift()))]), { statusCode: 200 })))
      }
      return request
    })
  try {
    await client.command('say Cześć')
    await assert.rejects(client.command('list'), { code: 'SERVER_NOT_RUNNING' })
    const first = transmissions[0]
    assert.equal(first.path, '/api/v2/servers/' + serverId + '/stdin')
    assert.equal(first.method, 'POST')
    assert.equal(first.headers.Authorization, 'Bearer test-command')
    assert.equal(first.headers['Content-Type'], 'text/plain; charset=utf-8')
    assert.equal(first.headers['Content-Length'], Buffer.byteLength('say Cześć'))
    assert.equal(first.body.toString('utf8'), 'say Cześć')
  } finally {
    client.close()
  }
})

test('klucz próby Crafty działa tylko dla list nawet przy bezpośrednim wywołaniu klienta', async () => {
  const attempts = []
  const client = makeCraftyClient({ address: 'https://127.0.0.1:18443', serverId: '74159569-204a-4ef3-9e0a-846eb9bd468e',
    listToken: 'test-list' }, (url, options, callback) => {
    const request = new EventEmitter()
    request.end = (body) => {
      attempts.push({ path: url.pathname, auth: options.headers.Authorization, body: body.toString('utf8') })
      queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from('{"status":"ok"}')]), { statusCode: 200 })))
    }
    return request
  })
  assert.throws(() => client.command('weather rain'), /command is unavailable/)
  await client.command('list')
  assert.deepEqual(attempts, [{ path: '/api/v2/servers/74159569-204a-4ef3-9e0a-846eb9bd468e/stdin', auth: 'Bearer test-list', body: 'list' }])
  client.close()
})

test('czyta surowe odpowiedzi kopii Crafty 4.11.0, ukrywa ścieżki i przywraca tylko w miejscu', async () => {
  const serverId = '74159569-204a-4ef3-9e0a-846eb9bd468e'
  const backupId = 'd78d31e8-52c5-4e40-be23-20d0c376e979'
  const filename = '2026-11-18_01-02-03.zip'
  const issued = []
  const replies = [{ server_id: { server_id: serverId }, backup_id: backupId, backup_location: '/valid',
    backup_type: 'zip_vault', enabled: true, shutdown: true, before: '', after: '', max_backups: 5,
    status: JSON.stringify({ status: 'Standby', message: '' }) },
  { backups: ['/valid/' + filename, '/secret/ignore.txt', 'C:\\valid\\' + filename] }, { status: 'ok' }, { status: 'ok' }]
  const client = makeCraftyClient({ address: 'https://127.0.0.1:18443', serverId, backupId, backupToken: 'test-backup' },
    (url, options, callback) => {
      const request = new EventEmitter()
      request.end = (body) => {
        issued.push({ path: url.pathname, ...options, body })
        queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(JSON.stringify(replies.shift()))]), { statusCode: 200 })))
      }
      return request
    })
  try {
    assert.deepEqual(await client.backupProfile(), { location: '/valid', zip: true, enabled: true, shutdown: true, hooks: false, keep: 5, state: 'ready' })
    assert.deepEqual(await client.backupFiles(), [filename])
    await client.queueBackup()
    assert.throws(() => client.restoreBackup('../' + filename))
    await client.restoreBackup(filename)
    assert.equal(issued[2].path, '/api/v2/servers/' + serverId + '/action/backup_server/' + backupId)
    assert.equal(issued[3].path, '/api/v2/servers/' + serverId + '/backups/backup/' + backupId)
    assert.deepEqual(JSON.parse(issued[3].body), { filename, inPlace: true })
    assert.equal(issued[3].headers.Authorization, 'Bearer test-backup')
    assert.equal(issued[3].headers['Content-Type'], 'application/json; charset=utf-8')
  } finally {
    client.close()
  }
})
