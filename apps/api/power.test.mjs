import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { makePowerController, validPowerRequest } from './power.mjs'

const taskTurn = () => new Promise((resolve) => setImmediate(resolve))

test('wymaga potwierdzenia stop i restart', () => {
  const id = randomUUID()
  assert.equal(validPowerRequest({ action: 'start', id }), true)
  for (const action of ['stop', 'restart']) {
    assert.equal(validPowerRequest({ action, id }), false)
    assert.equal(validPowerRequest({ action, id, confirmed: true }), true)
  }
  assert.equal(validPowerRequest({ action: 'shell', id, confirmed: true }), false)
})

test('zapisuje zamiar przed komendą, unika duplikatów i potwierdza restart na metrykach', async () => {
  const recorded = []
  const commands = []
  let phase = 0
  const power = makePowerController({
    journal: { entries: [], async save(entries) { recorded.push(entries.at(-1).status) } },
    async read() { return { running: true, startedAt: phase ? 15000 : 1000 } },
    async write(action) { assert.deepEqual(recorded, ['pending']); commands.push(action) },
    async wait() { phase++ },
  })
  const request = { action: 'restart', id: randomUUID(), confirmed: true }
  const accepted = await power.request(request, 'owner')
  assert.equal(accepted.status, 202)
  assert.equal((await power.request(request, 'owner')).status, 200)
  await taskTurn()
  assert.deepEqual(commands, ['restart'])
  assert.deepEqual(recorded, ['pending', 'done'])
  assert.equal(power.publicState().operation.actor, 'owner')
})

test('po niepewnym wyniku nie ponawia POST i blokuje inną operację do weryfikacji', async () => {
  let sends = 0
  const power = makePowerController({
    journal: { entries: [], async save() {} },
    async read() { return { running: true, startedAt: 1000 } },
    async write() { sends++; throw new Error('Network disconnected') },
    async wait() {},
    steps: 2,
  })
  const id = randomUUID()
  await power.request({ action: 'restart', id }, 'owner')
  await taskTurn()
  assert.equal(power.publicState().operation.status, 'uncertain')
  assert.equal((await power.request({ action: 'stop', id: randomUUID() }, 'owner')).status, 409)
  assert.equal((await power.acknowledge(id, 'owner')).status, 200)
  assert.equal(sends, 1)
})

test('wznowienie procesu traktuje niezamknięte zgłoszenie jako niepewne', async () => {
  const id = randomUUID()
  const power = makePowerController({
    journal: { entries: [{ action: 'start', actor: 'owner', id, status: 'pending' }] },
  })
  assert.equal(power.publicState().operation.status, 'uncertain')
  assert.equal((await power.request({ action: 'start', id }, 'owner')).status, 200)
  assert.equal((await power.request({ action: 'start', id: randomUUID() }, 'owner')).status, 409)
})
