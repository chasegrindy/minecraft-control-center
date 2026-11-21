import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeLivePlayerSource, normalizeDirectory, readPlayerDirectory, readSavedBossEvents } from './player-directory.mjs'

test('łączy uprawnienia według UUID i ogranicza pola dostępne w podglądzie', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-player-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'players.json')
  const player = { name: 'Alex', uuid: '7c3478de-7556-41e5-855a-2d2a416d0bb9' }
  const snapshot = {
    capturedAt: Date.parse('2026-11-18T17:00:00Z'),
    whitelistEnabled: true,
    profiles: [player],
    whitelist: [{ ...player, name: 'PreviousName' }],
    operators: [{ ...player, level: 3 }],
    banned: null,
    deaths: { rows: [{ uuid: player.uuid, dimension: 'nether', x: -4, y: 87, z: 50 }], skipped: 0 },
    activity: { rows: [{ uuid: player.uuid, stats: { playTicks: 72_000, deaths: 2, mobKills: 43 },
      dragonAt: Date.parse('2026-11-18T15:30:00Z') }], skipped: 0 },
  }
  await writeFile(path, JSON.stringify(snapshot))
  const result = await readPlayerDirectory({ operator: true, path })
  assert.equal(result.whitelistEnabled, true)
  assert.deepEqual(result.players, [{ ...player, whitelisted: true, operator: true, operatorLevel: 3, banned: null,
    statistics: { playTicks: 72_000, deaths: 2, mobKills: 43 } }])
  assert.deepEqual(result.lastDeaths, { positions: [{ ...player, dimension: 'nether', x: -4, y: 87, z: 50 }], skipped: 0 })
  const viewer = await readPlayerDirectory({ operator: false, path })
  assert.equal(viewer.whitelistEnabled, null)
  assert.deepEqual(viewer.players, [player])
  assert.equal('lastDeaths' in viewer, false)
  const [event] = await readSavedBossEvents(path)
  assert.deepEqual({ ...event, id: undefined }, { id: undefined, source: 'minecraft-advancements', type: 'boss',
    player: player.name, time: Date.parse('2026-11-18T15:30:00Z'), detail: 'Free the End' })
  assert.throws(() => normalizeDirectory({ ...snapshot, activity: { ...snapshot.activity,
    rows: [{ ...snapshot.activity.rows[0], dragonAt: snapshot.capturedAt + 1 }] } }), /Invalid dragon/)
  assert.throws(() => normalizeDirectory({ ...snapshot, operators: [{ ...player, level: 6 }] }), /Invalid player/)
  assert.throws(() => normalizeDirectory({ ...snapshot,
    deaths: { rows: [{ uuid: player.uuid, dimension: 'nether', x: 42_000_000, y: 64, z: 0 }], skipped: 0 } }), /Invalid last death position/)
})

test('odświeża dostęp według UUID i zachowuje statystyki z migawki', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-player-live-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'instance')
  await mkdir(root)
  const path = join(directory, 'snapshot.json')
  const old = { name: 'PreviousName', uuid: '7c3478de-7556-41e5-855a-2d2a416d0bb9' }
  const renamed = { name: 'Alex', uuid: old.uuid.toUpperCase() }
  const added = { name: 'NewPlayer', uuid: 'bb3478de-7556-41e5-855a-2d2a416d0bb9' }
  const statistics = { playTicks: 43, deaths: 4, mobKills: 22 }
  const capturedAt = Date.parse('2026-11-18T17:00:00Z')
  let now = capturedAt + 60_000
  await writeFile(path, JSON.stringify({ capturedAt, whitelistEnabled: false, profiles: [old],
    whitelist: [old], operators: [{ ...old, level: 2 }], banned: [old],
    activity: { rows: [{ uuid: old.uuid, stats: statistics }], skipped: 0 } }))
  const write = (name, content) => writeFile(join(root, name), JSON.stringify(content))
  await Promise.all([
    write('usercache.json', [renamed, added]), write('whitelist.json', [added]),
    write('ops.json', [{ ...added, level: 4 }]),
    write('banned-players.json', [
      { ...renamed, expires: '2026-11-18 18:00:00 +0100', reason: 'Expired private reason' },
      { ...added, expires: 'forever', reason: 'Private reason' },
    ]),
    writeFile(join(root, 'server.properties'), 'white-list=false\nwhite-list : TRUE\nrcon.password=private\n'),
  ])
  const readLive = makeLivePlayerSource(root, () => now)
  const read = () => readPlayerDirectory({ operator: true, path, readLive })
  const [first, same] = await Promise.all([read(), read()])
  assert.deepEqual(first, same)
  assert.equal(first.whitelistEnabled, true)
  assert.equal(first.capturedAt, capturedAt)
  assert.deepEqual(first.access, { source: 'live', at: now })
  assert.deepEqual(first.players, [
    { ...old, name: renamed.name, whitelisted: false, operator: false, operatorLevel: null, banned: false, statistics },
    { ...added, whitelisted: true, operator: true, operatorLevel: 4, banned: true },
  ])
  assert.doesNotMatch(JSON.stringify(first), /private/i)
  const viewer = await readPlayerDirectory({ operator: false, path, readLive: () => { assert.fail('Viewer reads access files') } })
  assert.deepEqual(viewer.players, [old])
  assert.equal('access' in viewer, false)

  await Promise.all([write('whitelist.json', []), write('ops.json', []), write('banned-players.json', [])])
  now += 2_001
  assert.deepEqual((await read()).players[1], { ...added, whitelisted: false, operator: false, operatorLevel: null, banned: false })

  await writeFile(join(root, 'ops.json'), '[')
  now += 2_001
  assert.equal((await read()).players[1].operator, null)
  assert.equal((await read()).players[1].whitelisted, false)

  const savedSnapshot = await readPlayerDirectory({ operator: true, path })
  const snapshotBytes = JSON.stringify({ capturedAt, whitelistEnabled: false, profiles: [old],
    whitelist: [old], operators: [{ ...old, level: 2 }], banned: [old] })
  await writeFile(path, 'broken snapshot')
  assert.equal((await read()).access.source, 'live')
  await writeFile(path, snapshotBytes)

  await rm(root, { recursive: true })
  now += 2_001
  const fallback = await read()
  assert.deepEqual(fallback.access, { source: 'snapshot', at: capturedAt })
  assert.equal(fallback.players[0].operator, savedSnapshot.players[0].operator)
  assert.equal(fallback.whitelistEnabled, false)
})
