import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeCommandService, parseGameCommand } from './game-command.mjs'

test('kanonizuje wyłącznie dozwolone komendy i argumenty Fabric 1.21.11', () => {
  const accepted = [
    ['/list', 'list', false], ['say Cześć ekipo!', 'say Cześć ekipo!', true],
    ['  /weather   thunder  ', 'weather thunder', true], ['time set noon', 'time set noon', true],
    ['save-all', 'save-all', true], ['whitelist add Alex_2', 'whitelist add Alex_2', true],
    ['gamerule keep_inventory', 'gamerule minecraft:keep_inventory', false],
    ['gamerule minecraft:advance_time false', 'gamerule minecraft:advance_time false', true],
    ['gamerule players_sleeping_percentage 100', 'gamerule minecraft:players_sleeping_percentage 100', true],
    ['deop Test_1', 'deop Test_1', true], ['pardon Test_1', 'pardon Test_1', true],
  ]
  for (const [input, text, confirm] of accepted) {
    assert.deepEqual(parseGameCommand(input), { kind: text.split(' ')[0], text, confirm })
  }
  for (const input of ['', null, 'stop', 'execute run op Test_1', 'weather snow', 'weather rain second',
    'op @a', 'ban Test_1 reason', 'kick Test_1\nstop', 'say Cześć\u0085stop', 'time set night\u2028stop',
    'gamerule command_blocks_work true', 'gamerule players_sleeping_percentage 101', 'gamerule advance_time True',
    'save-all flush', 'whitelist remove ../Alex']) {
    assert.equal(parseGameCommand(input), null)
  }
})

test('potwierdza zapis do dziennika przed wysłaniem i rozróżnia wynik od właściwego skutku komendy', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcc-command-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'commands.json')
  const seen = []
  let time = 0
  const service = await makeCommandService({ file, now: () => time, async send(text) {
    const journal = await readFile(file, 'utf8')
    assert.equal(JSON.parse(journal).at(-1).status, 'pending')
    if (text.startsWith('say ')) assert.equal(journal.includes(text), false)
    seen.push(text)
    if (text === 'list') throw new Error('Nie udało się odebrać odpowiedzi')
    if (text === 'whitelist list') throw Object.assign(new Error('Proces się zatrzymał'), { code: 'SERVER_NOT_RUNNING' })
  } })
  const saved = { id: randomUUID(), command: 'say Poufna wiadomość' }
  assert.equal((await service.execute(saved, 'operator')).status, 400)
  assert.deepEqual(seen, [])
  saved.confirmed = true
  assert.equal((await service.execute(saved, 'operator')).data.outcome, 'submitted')
  assert.equal((await service.execute(saved, 'operator')).data.outcome, 'submitted')
  assert.equal((await service.execute(saved, 'someone_else')).status, 409)
  assert.equal((await service.execute({ ...saved, command: 'list' }, 'operator')).status, 409)
  const second = { id: randomUUID(), command: 'list' }
  assert.equal((await service.execute(second, 'operator')).status, 429)
  time = 1100
  assert.equal((await service.execute(second, 'operator')).data.outcome, 'uncertain')
  assert.equal((await service.execute(second, 'operator')).data.outcome, 'uncertain')
  time += 1100
  assert.equal((await service.execute({ id: randomUUID(), command: 'whitelist list' }, 'operator')).data.outcome, 'rejected')
  assert.deepEqual(seen, ['say Poufna wiadomość', 'list', 'whitelist list'])
})

test('teleportacja przyjmuje wyłącznie jeden nick i bezwzględny punkt w obsługiwanym wymiarze', () => {
  const valid = [
    'execute in minecraft:overworld run teleport Alex_2 -29999999 -64 29999999',
    'execute in minecraft:the_nether run teleport Alex 0 255 0',
    'execute in minecraft:the_end run teleport Alex 100 0 -50',
  ]
  for (const text of valid) assert.deepEqual(parseGameCommand(text), { kind: 'teleport', text, confirm: true })
  for (const input of [
    'execute in other:overworld run teleport Alex 0 65 0',
    'execute in minecraft:overworld run teleport @a 0 65 0',
    'execute in minecraft:overworld run teleport Alex ~ 65 0',
    'execute in minecraft:overworld run teleport Alex 0 320 0',
    'execute in minecraft:the_nether run teleport Alex 0 -1 0',
    'execute in minecraft:the_end run teleport Alex 0 65 30000000',
    'execute in minecraft:the_end run teleport Alex 0 65 0 facing 0 65 0',
    'execute in minecraft:the_end run ban Alex',
  ]) assert.equal(parseGameCommand(input), null)
})

test('tryb pierwszej próby przepuszcza tylko list i nie wysyła ponowionego zgłoszenia', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcc-list-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'commands.json')
  const sent = []
  const service = await makeCommandService({ file, mode: 'list', send: async (text) => { sent.push(text) } })
  assert.equal(service.mode, 'list')
  for (const command of ['weather rain', 'save-all', 'op Alex', 'whitelist list', 'gamerule keep_inventory',
    'execute in minecraft:the_nether run teleport Alex 0 65 0']) {
    const request = { id: randomUUID(), command, confirmed: true }
    assert.deepEqual(await service.execute(request, 'operator'), { status: 403, data: { error: 'mode' } })
  }
  const list = { id: randomUUID(), command: '/list' }
  assert.equal((await service.execute(list, 'operator')).data.outcome, 'submitted')
  assert.equal((await service.execute(list, 'operator')).data.outcome, 'submitted')
  assert.deepEqual(sent, ['list'])
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1)
  await assert.rejects(makeCommandService({ file, mode: 'typo', send: async () => {} }), /Invalid MCC command mode/)
})
