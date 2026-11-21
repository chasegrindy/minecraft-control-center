import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { accountsPath, removeAccount, saveAccount, validName, validRole } from './accounts.mjs'

const [username, role, option, ...unexpected] = process.argv.slice(2)
if (!validName(username) || !(validRole(role) || role === 'remove') || unexpected.length
  || (option && (role === 'remove' || option !== '--setup-file'))) {
  console.error('Użycie: npm run account -- <login> <viewer|operator|remove> [--setup-file]')
  process.exit(1)
}

const password = randomBytes(21).toString('base64url')
const setupFile = join(dirname(accountsPath), 'mcc-' + username + '-login.txt')
let createdFile = false
try {
  if (role === 'remove') {
    await removeAccount(username)
    await rm(setupFile, { force: true })
    console.log('Usunięto konto MCC:', username)
  } else {
    if (option) {
      await mkdir(dirname(accountsPath), { recursive: true, mode: 0o700 })
      await writeFile(setupFile, 'Login: ' + username + '\nHasło: ' + password + '\n', { flag: 'wx', mode: 0o600 })
      createdFile = true
    }
    await saveAccount(username, role, password)
    if (option) console.log('Dane logowania zapisane w prywatnym pliku:', setupFile)
    else {
      console.log('Login:', username)
      console.log('Nowe hasło:', password)
    }
  }
} catch {
  if (createdFile) await rm(setupFile, { force: true })
  console.error('Nie udało się zapisać konta lub pliku logowania MCC.')
  process.exitCode = 1
}
