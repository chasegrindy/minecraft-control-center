import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makePositionSource } from './squaremap.mjs'

const player = {
  uuid: '8b5b5cdd1c2a425fbc30dc805acc01bf', name: 'Player_1', world: 'minecraft_the_nether',
  x: -41, y: 75, z: 18, display_name: '<b>Custom name</b>', armor: 4, health: 17,
}
const live = (data) => Response.json(data, { headers: { ETag: '1795025325999' } })

test('czyta wyłącznie lokalne pozycje squaremap i zwraca dozwolone pola i wymiary', async () => {
  const read = makePositionSource('18792', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18792/tiles/players.json')
    assert.equal(options.redirect, 'error')
    return live({ max: 20, players: [player,
      { ...player, uuid: '762acb185db64f4d92b21cf3b17fcc12', world: 'minecraft_the_end', name: 'End_2' },
      { ...player, uuid: '5ab77820ee4e48d8a4a083b35483872e', world: 'minecraft_overworld', name: 'Hidden', x: null, z: null },
      { ...player, uuid: 'fdd9939258e14e969afbb85e2e16886d', world: 'custom_overworld', name: 'Custom' },
    ] })
  })
  assert.deepEqual(await read(), [
    { uuid: '762acb185db64f4d92b21cf3b17fcc12', name: 'End_2', dimension: 'end', x: -41, y: 75, z: 18 },
    { uuid: player.uuid, name: 'Player_1', dimension: 'nether', x: -41, y: 75, z: 18 },
  ])
})

test('rozróżnia pusty serwer i niedostępne, zapisane na dysku lub nadmierne odpowiedzi', async () => {
  assert.equal(makePositionSource(undefined), null)
  assert.throws(() => makePositionSource('http://example.test'))
  assert.deepEqual(await makePositionSource('18792', async () => live({ players: [] }))(), [])
  await assert.rejects(makePositionSource('18792', async () => Response.json({ players: [player] }, { headers: { ETag: '"1795025325999"' } }))())
  await assert.rejects(makePositionSource('18792', async () => live({ max: 20 }))())
  await assert.rejects(makePositionSource('18792', async () => new Response(' '.repeat(256 * 1024 + 1),
    { headers: { ETag: '1795025325999' } }))(), /too large/)
})
