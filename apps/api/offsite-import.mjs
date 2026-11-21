import { dirname, join, resolve } from 'node:path'
import { configPath } from './config.mjs'
import { importOffsiteBackup } from './offsite-backup.mjs'

if (process.argv.length !== 3) {
  console.error('Użycie: npm run backup:offsite -- <ścieżka do ZIP z Crafty>')
  process.exit(1)
}

const recovery = resolve(dirname(configPath), 'recovery')
const directory = join(recovery, 'archives')
const world = process.env.MCC_CRAFTY_WORLD_FOLDER ?? 'world'
const age = join(recovery, 'tools', 'age', process.platform === 'win32' ? 'age.exe' : 'age')
const identity = join(recovery, 'keys', 'mcc-age-identity.txt')
try {
  const saved = await importOffsiteBackup({ source: process.argv[2], directory, age, identity, world })
  console.log('Zaszyfrowana kopia w katalogu MCC · ' + saved.id + ' · SHA-256 ' + saved.encryptedSha256)
} catch (error) {
  console.error(error.code ? 'Import kopii nie powiódł się (' + error.code + ').' : error.message)
  process.exitCode = 1
}
