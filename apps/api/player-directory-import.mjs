import { writeJson } from './json-store.mjs'
import { normalizeDirectory, playerDirectoryPath } from './player-directory.mjs'
import { maxInventoryBytes, normalizeInventories, playerInventoryPath } from './player-inventory.mjs'

const args = process.argv.slice(2)
const inventories = args.length === 1 && args[0] === '--inventories'
if (args.length && !inventories) throw new Error('Dozwolona opcja importu to --inventories.')
const limit = inventories ? maxInventoryBytes : 2_000_000
let contents = ''
process.stdin.setEncoding('utf8')
for await (const part of process.stdin) {
  contents += part
  if (contents.length > limit) throw new Error('Migawka graczy przekracza limit.')
}
const snapshot = JSON.parse(contents)
if (inventories) {
  const data = normalizeInventories(snapshot)
  await writeJson(playerInventoryPath, data, { durable: true })
  console.log('Migawki ekwipunku w MCC: ' + data.players.length + '.')
} else {
  const directory = normalizeDirectory(snapshot)
  await writeJson(playerDirectoryPath, snapshot)
  console.log('Profile graczy w MCC: ' + directory.players.length + '.')
  if (directory.lastDeaths) {
    console.log('Ostatnie miejsca śmierci w MCC: ' + directory.lastDeaths.positions.length + '. Pominięte zapisy: ' + directory.lastDeaths.skipped + '.')
  }
  if (snapshot.activity) {
    console.log('Statystyki graczy: ' + directory.players.filter((player) => player.statistics).length
      + '. Zapisane osiągnięcia smoka: ' + directory.bossEvents.length + '. Pominięte pliki: ' + snapshot.activity.skipped + '.')
  }
}
