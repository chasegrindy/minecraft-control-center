import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeEventStore, mergeWorldActivity, normalizeLogEvents, observedEvents, parseServerEvent } from './world-events.mjs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const midnight = Date.parse('2026-11-18T00:00:00Z')
const line = (time, text) => '[' + time + '] [Server thread/INFO]: ' + text

test('rozpoznaje znane komunikaty gry bez czatu i bez przypisywania współrzędnych', () => {
  const examples = [
    ['Stone_11 joined the game', 'join', null],
    ['Stone_11 left the game', 'leave', null],
    ['Stone_11 has made the advancement [Sweet Dreams]', 'advancement', 'Sweet Dreams'],
    ['Stone_11 has completed the challenge [Postmortal]', 'advancement', 'Postmortal'],
    ['Stone_11 was slain by Zombie', 'death', 'was slain by Zombie'],
  ]
  for (const [text, type, detail] of examples) {
    const event = parseServerEvent(line('00:01:00', text), midnight)
    assert.equal(event.type, type)
    assert.equal(event.detail, detail)
    assert.equal(event.time, midnight + 60_000)
    assert.equal(event.player, 'Stone_11')
    assert.equal(event.location, undefined)
  }
  assert.equal(parseServerEvent(line('00:00:00', '<Someone> Stone_11 joined the game'), midnight), null)
  assert.equal(parseServerEvent(line('00:00:00', 'Stone_11 moved too quickly!'), midnight), null)
})

test('wykrywa nowe linie w przesuwającym się ogonie, uwzględnia północ i ochronę przed starym logiem', () => {
  const prior = line('23:59:57', 'Stone_11 joined the game')
  const beforeMidnight = line('23:59:59', 'Stone_11 drowned')
  const afterMidnight = line('00:00:01', 'Stone_11 left the game')
  const previous = [line('21:00:00', 'Server ready'), prior]
  const next = [prior, beforeMidnight, afterMidnight]
  assert.deepEqual(observedEvents(null, next, null, midnight + 2000), [])
  assert.deepEqual(observedEvents(next, next, midnight - 3000, midnight + 2000), [])
  const detected = observedEvents(previous, next, midnight - 3000, midnight + 2000)
  assert.deepEqual(detected.map(({ type, time }) => [type, time]), [
    ['death', midnight - 1000], ['leave', midnight + 1000],
  ])
  assert.deepEqual(observedEvents(previous, [beforeMidnight, afterMidnight], midnight - 3000, midnight + 2000), detected)
  assert.deepEqual(observedEvents(previous, next, midnight - 3000, midnight + 86_400_000), [])
})

test('historia zdarzeń zachowuje wpisy po ponownym otwarciu i deduplikuje import', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'mcc-events-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const file = join(path, 'events.json')
  const joinEvent = parseServerEvent(line('11:26:00', 'Stone_11 joined the game'), midnight)
  const leaveEvent = parseServerEvent(line('11:30:00', 'Stone_11 left the game'), midnight)
  const store = makeEventStore(file)
  assert.deepEqual(await store.read(), [])
  await store.append([joinEvent])
  const imported = normalizeLogEvents([{ ...joinEvent, raw: 'Pole spoza schematu' }, leaveEvent])
  assert.deepEqual(imported, [joinEvent, leaveEvent])
  assert.throws(() => normalizeLogEvents([{ ...joinEvent, player: null }]), /Invalid MCC world events/)
  await store.append(imported)
  await store.append(imported)
  assert.deepEqual(await makeEventStore(file).read(), [leaveEvent, joinEvent])
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [leaveEvent, joinEvent])
})

test('pojedyncze ukończenie smoka jest prezentowane jako wydarzenie z zapisanej daty', () => {
  const same = parseServerEvent(line('11:12:13', 'Stone_11 has made the advancement [Free the End]'), midnight)
  const later = parseServerEvent(line('11:12:55', 'Stone_11 has made the advancement [Free the End]'), midnight)
  const boss = { ...same, id: 'game-save', source: 'minecraft-advancements', type: 'boss' }
  assert.deepEqual(mergeWorldActivity([same, later], [boss]), [later, boss])
})
