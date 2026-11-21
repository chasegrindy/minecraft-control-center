import { dirname, join } from 'node:path'
import { configPath } from './config.mjs'
import { restoreOffsiteWorld } from './offsite-backup.mjs'

const [id, destination, ...extra] = process.argv.slice(2)
if (!id || !destination || extra.length) {
  console.error('Użycie: npm run backup:restore -- <identyfikator kopii crafty-...> <nowy katalog docelowy>')
  process.exit(1)
}

const recovery = join(dirname(configPath), 'recovery')
try {
  const result = await restoreOffsiteWorld({ id, destination, directory: join(recovery, 'archives'),
    identity: join(recovery, 'keys', 'mcc-age-identity.txt'), world: process.env.MCC_CRAFTY_WORLD_FOLDER ?? 'world',
    age: join(recovery, 'tools', 'age', process.platform === 'win32' ? 'age.exe' : 'age') })
  console.log(`Odtworzono ${result.files} plików świata w ${result.worldPath}`)
} catch (error) {
  console.error(error.code ? 'Odtworzenie świata nie powiodło się (' + error.code + ').' : error.message)
  process.exitCode = 1
}
