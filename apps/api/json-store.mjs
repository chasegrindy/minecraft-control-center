import { randomBytes } from 'node:crypto'
import { open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeJson(file, value, { durable = false, groupReadable = false } = {}) {
  const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: durable })
    if (groupReadable) {
      const staged = await open(temporary, 'r+')
      try {
        await staged.chmod(0o640)
        if (durable) await staged.sync()
      } finally {
        await staged.close()
      }
    }
    await rename(temporary, file)
    if (durable && process.platform !== 'win32') {
      const directory = await open(dirname(file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
