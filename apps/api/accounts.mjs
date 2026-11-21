import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { configPath } from './config.mjs'

export const accountsPath = process.env.MCC_ACCOUNTS_CONFIG ?? join(dirname(configPath), 'accounts.json')
const derive = promisify(scrypt)
const options = { N: 2 ** 15, r: 8, p: 3, maxmem: 48 * 1024 * 1024 }
const accountNames = /^[a-z][a-z0-9_-]{2,31}$/
const base64url32 = /^[A-Za-z0-9_-]{43}$/
const base64url16 = /^[A-Za-z0-9_-]{22}$/
const dummy = { salt: randomBytes(16).toString('base64url'), hash: randomBytes(32).toString('base64url') }

export function validName(username) {
  return typeof username === 'string' && accountNames.test(username)
}

export function validRole(role) {
  return role === 'viewer' || role === 'operator'
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password, 'utf8') <= 256
}

export async function loadAccounts(path = accountsPath) {
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
  const accounts = new Map()
  const document = JSON.parse(content)
  if (!Array.isArray(document) || document.length > 25) throw new Error('Invalid MCC accounts')
  for (const account of document) {
    if (!validName(account?.username) || !validRole(account.role) || accounts.has(account.username)
      || !base64url16.test(account.salt) || !base64url32.test(account.hash)
      || !base64url16.test(account.revision)) throw new Error('Invalid MCC account')
    accounts.set(account.username, account)
  }
  return accounts
}

export async function verifyPassword(password, account) {
  const { salt, hash } = account ?? dummy
  const actual = await derive(password, Buffer.from(salt, 'base64url'), 32, options)
  return timingSafeEqual(actual, Buffer.from(hash, 'base64url')) && account !== undefined
}

async function changeAccounts(path, change) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const lock = path + '.lock'
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp'
  await writeFile(lock, '', { flag: 'wx', mode: 0o600 })
  try {
    const accounts = await loadAccounts(path)
    await change(accounts)
    await writeFile(temporary, JSON.stringify([...accounts.values()]), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
    await rm(lock, { force: true })
  }
}

export async function saveAccount(username, role, password, path = accountsPath) {
  if (!validName(username) || !validRole(role) || !validPassword(password)) throw new Error('Invalid MCC account input')
  await changeAccounts(path, async (accounts) => {
    if (accounts.size >= 25 && !accounts.has(username)) throw new Error('Limit MCC accounts reached')
    const salt = randomBytes(16)
    const hash = await derive(password, salt, 32, options)
    accounts.set(username, {
      username,
      role,
      revision: randomBytes(16).toString('base64url'),
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
    })
  })
}

export async function removeAccount(username, path = accountsPath) {
  if (!validName(username)) throw new Error('Invalid MCC account name')
  await changeAccounts(path, (accounts) => accounts.delete(username))
}
