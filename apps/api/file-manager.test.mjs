import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeFileManager } from './file-manager.mjs'
import { applyProperties, inspectProperties, validPropertyChanges } from './server-properties.mjs'

test('odczytuje tylko wybrane ustawienia i zachowuje bajty kluczy spoza edycji', () => {
  const source = Buffer.from('# komentarz\r\nmotd=Zażółć\\\r\n  test\r\nmax-players : 10\r\nmax-players=12\r\nrcon.password=prywatne\r\nonline-mode=true', 'utf8')
  assert.equal(inspectProperties(source).values.motd, 'Zażółćtest')
  assert.equal(inspectProperties(source).values['max-players'], 12)
  assert.equal('rcon.password' in inspectProperties(source).values, false)
  assert.equal(validPropertyChanges({ 'rcon.password': 'x' }), false)
  assert.equal(validPropertyChanges({ eula: true }), false)
  assert.equal(validPropertyChanges({ motd: 'wielowierszowy\nklucz=true' }), false)
  const next = applyProperties(source, { motd: ' Łódź \\ ', 'max-players': 20, difficulty: 'hard' })
  assert.equal(inspectProperties(next).values.motd, ' Łódź \\ ')
  assert.equal(inspectProperties(next).values['max-players'], 20)
  assert.equal(inspectProperties(next).values.difficulty, 'hard')
  assert.match(next.toString(), /rcon.password=prywatne\r\nonline-mode=true\r\n/)
  assert.doesNotMatch(applyProperties(next, { 'max-players': null }).toString(), /max-players/)
})

test('blokuje zapis przy działającej grze, wymaga rewizji i przywraca dozwolone wartości', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'instance')
  const properties = join(root, 'server.properties')
  await mkdir(root)
  await mkdir(join(root, 'mods'))
  await writeFile(join(root, 'mods', 'fixture.jar'), 'zip sample')
  await writeFile(join(root, 'secret.txt'), 'why')
  await writeFile(properties, 'motd=Przed\nrcon.password=chronione\n')
  let running = true
  const manager = makeFileManager({ root, journal: join(directory, 'history.json'), allowWrites: true, readRunning: () => running })
  const first = await manager.info()
  assert.equal(first.writable, true)
  assert.equal(first.entries.some(({ name }) => name === 'secret.txt'), false)
  assert.equal(first.mods[0].name, 'fixture.jar')
  const change = { id: randomUUID(), kind: 'edit', confirmed: true, revision: first.properties.revision, changes: { motd: 'Po', difficulty: 'hard' } }
  await assert.rejects(manager.change(change, 'mcc'), { code: 'running' })
  running = false
  const saved = await manager.change(change, 'mcc')
  assert.equal(saved.status, 'applied')
  assert.equal((await manager.change(change, 'mcc')).id, saved.id)
  await assert.rejects(manager.change({ ...change, changes: { motd: 'Inne' } }, 'mcc'), { code: 'conflict' })
  await assert.rejects(manager.change({ ...change, id: randomUUID() }, 'mcc'), { code: 'changed' })
  const next = await manager.info()
  assert.equal(next.properties.values.difficulty, 'hard')
  assert.doesNotMatch(JSON.stringify(next), /chronione/)
  const journal = await readFile(join(directory, 'history.json'), 'utf8')
  assert.doesNotMatch(journal, /chronione|rcon.password/)
  await manager.change({ id: randomUUID(), kind: 'restore', confirmed: true, revision: next.properties.revision, from: saved.id }, 'mcc')
  assert.equal(await readFile(properties, 'utf8'), 'motd=Przed\nrcon.password=chronione\n')
})

test('pomija katalog mods wskazujący poza instancję', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcc-files-link-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'game')
  const other = join(directory, 'unrelated')
  await mkdir(root)
  await mkdir(other)
  await writeFile(join(other, 'private.jar'), 'external')
  try {
    await symlink(other, join(root, 'mods'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
    t.skip('Windows sandbox blocks the creation of reparse points')
    return
  }
  const manager = makeFileManager({ root, journal: join(directory, 'history.json') })
  assert.deepEqual((await manager.info()).mods, [])
  assert.equal((await manager.info()).entries.length, 0)
})
