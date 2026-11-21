import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipRaw } from 'unzipit'
import { FileOperationError } from './file-manager.mjs'
import { writeJson } from './json-store.mjs'

export const maxModBytes = 32 * 1024 * 1024
export const modDigest = /^[a-f0-9]{64}$/
export const modFilename = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,154}\.jar$/i
const modId = /^[a-z][a-z0-9_-]{1,63}$/
const maxMetadata = 64 * 1024
const maxStaged = 8

function stableVersion(version) {
  if (typeof version !== 'string') return null
  const match = version.match(/^(\d{1,9}(?:\.\d{1,9}){0,3})(?:\+[A-Za-z0-9.-]+)?$/)
  return match ? match[1].split('.').map(Number) : null
}

function predicate(test, actual) {
  if (test === '*') return true
  const wildcard = test.match(/^(\d{1,9}(?:\.\d{1,9})?)\.[*xX]$/)
  if (wildcard) return wildcard[1].split('.').every((part, index) => Number(part) === (actual[index] ?? 0))
  const match = test.match(/^([<>=~^]{0,2})(\d{1,9}(?:\.\d{1,9}){0,3})(-[0-9A-Za-z.-]*)?(?:\+[A-Za-z0-9.-]+)?$/)
  if (!match) return null
  const [, operator, base, prerelease] = match
  const expected = base.split('.').map(Number)
  let diff = 0
  for (let index = 0; index < Math.max(actual.length, expected.length); index++) {
    diff = (actual[index] ?? 0) - (expected[index] ?? 0)
    if (diff) break
  }
  if (!diff && prerelease) diff = 1
  switch (operator) {
    case '':
    case '=': return diff === 0
    case '>': return diff > 0
    case '>=': return diff >= 0
    case '<': return diff < 0
    case '<=': return diff <= 0
    case '^': return diff >= 0 && actual[0] === expected[0]
    case '~': return diff >= 0 && actual[0] === expected[0] && (actual[1] ?? 0) === (expected[1] ?? 0)
    default: return null
  }
}

export function matchesFabricVersion(range, version) {
  const actual = stableVersion(version)
  if (typeof version !== 'string' || !version || range === undefined) return null
  const alternatives = Array.isArray(range) ? range : [range]
  if (!alternatives.length || alternatives.length > 20) return null
  const matches = alternatives.map((option) => {
    if (typeof option !== 'string' || !option.trim() || option.length > 160) return null
    if (option.trim() === '*') return true
    if (!actual) return option.trim() === version || option.trim() === '=' + version ? true : null
    const terms = option.trim().split(/\s+/).map((term) => predicate(term, actual))
    if (terms.includes(null)) return null
    return terms.every(Boolean)
  })
  return matches.includes(true) ? true : matches.includes(null) ? null : false
}

async function archiveMetadata(jar, optional = false) {
  try {
    const { entries } = await unzipRaw(jar)
    const candidates = entries.filter((entry) => entry.name === 'fabric.mod.json')
    if (!candidates.length && optional) return null
    if (candidates.length !== 1) throw new Error('Missing or ambiguous metadata')
    const entry = candidates[0]
    if (entry.isDirectory || entry.encrypted || entry.size < 2 || entry.size > maxMetadata) throw new Error('Invalid metadata size')
    const bytes = await entryBytes(entry, maxMetadata)
    return { entries, data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  } catch {
    throw new FileOperationError(422, 'fabric-metadata')
  }
}

async function entryBytes(entry, limit) {
  const chunks = []
  let size = 0
  for await (const part of await entry.stream()) {
    size += part.byteLength
    if (size > limit) throw new Error('Exceeded entry size')
    chunks.push(Buffer.from(part))
  }
  return Buffer.concat(chunks, size)
}

function validateMetadata(data) {
  if (data?.schemaVersion !== 1 || typeof data.id !== 'string' || !modId.test(data.id)
    || typeof data.version !== 'string' || !data.version || data.version.length > 128 || /[\p{C}]/u.test(data.version)
    || !['*', 'client', 'server', undefined].includes(data.environment)
    || [data.depends, data.breaks].some((value) => value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((id) => !modId.test(id))))) {
    throw new FileOperationError(422, 'fabric-metadata')
  }
}

function report(data, versions) {
  const targets = { minecraft: versions.minecraft, fabricloader: versions.fabricloader, java: versions.java }
  const checks = Object.entries(targets).map(([id, target]) => {
    const requirement = data.depends?.[id]
    const required = requirement === undefined && id !== 'minecraft' ? true : matchesFabricVersion(requirement, target)
    const incompatible = data.breaks?.[id] === undefined ? false : matchesFabricVersion(data.breaks[id], target)
    return { id, target, verdict: required === false || incompatible === true ? 'no'
      : required === null || incompatible === null ? 'unknown' : 'yes' }
  })
  const dependencies = Object.keys(data.depends ?? {}).filter((id) => modId.test(id) && !Object.hasOwn(targets, id)).slice(0, 50)
  const verdict = data.environment === 'client' || checks.some((check) => check.verdict === 'no') ? 'no'
    : checks.some((check) => check.verdict === 'unknown') ? 'unknown' : 'yes'
  return { id: data.id, version: data.version, environment: data.environment ?? '*', verdict, checks, dependencies }
}

export async function inspectFabricMod(jar, versions) {
  if (jar.byteLength === 0 || jar.byteLength > maxModBytes) throw new FileOperationError(413, 'mod-size')
  const { data } = await archiveMetadata(jar)
  validateMetadata(data)
  return report(data, versions)
}

export async function scanFabricArchive(jar, budget, optional = false, depth = 0) {
  if (++budget.archives > 500 || depth > 8) throw new FileOperationError(409, 'mod-inventory')
  const archive = await archiveMetadata(jar, optional)
  if (!archive) return []
  const { data, entries } = archive
  validateMetadata(data)
  if (data.environment === 'client') return []
  const aliases = data.provides ?? []
  const nested = data.jars ?? []
  if (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === 'string' && modId.test(alias))
    || !Array.isArray(nested)) throw new FileOperationError(422, 'fabric-metadata')
  const mods = [{ id: data.id, version: data.version, provides: aliases, depends: data.depends ?? {}, breaks: data.breaks ?? {} }]
  const nestedNames = new Set()
  for (const declaration of nested) {
    const file = declaration?.file
    if (typeof file !== 'string' || !file || nestedNames.has(file)) throw new FileOperationError(422, 'fabric-metadata')
    nestedNames.add(file)
    const found = entries.filter((entry) => entry.name === file)
    if (found.length !== 1 || found[0].encrypted || found[0].isDirectory) throw new FileOperationError(422, 'fabric-metadata')
    const inner = found[0]
    if (inner.size <= 0 || inner.size > maxModBytes || budget.bytes + inner.size > 96 * 1024 * 1024) {
      throw new FileOperationError(409, 'mod-inventory')
    }
    budget.bytes += inner.size
    mods.push(...await scanFabricArchive(await entryBytes(inner, maxModBytes), budget, false, depth + 1))
  }
  return mods
}

export function makeModStaging({ directory, versions, now = Date.now }) {
  let busy = false
  async function list() {
    let filenames
    try { filenames = await readdir(directory) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const results = await Promise.all(filenames.filter((file) => file.endsWith('.json') && modDigest.test(file.slice(0, -5))).map(async (file) => {
      try {
        const info = await lstat(join(directory, file))
        if (!info.isFile() || info.size > 32_768) return null
        const entry = JSON.parse(await readFile(join(directory, file), 'utf8'))
        const jar = await lstat(join(directory, file.slice(0, -5) + '.jar'))
        return entry?.digest === file.slice(0, -5) && jar.isFile() && jar.size === entry.size ? entry : null
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
    }))
    return results.filter(Boolean).sort((a, b) => b.stagedAt - a.stagedAt)
  }
  function checkBusy() {
    if (busy) throw new FileOperationError(409, 'busy')
    busy = true
  }
  return {
    list,
    async read(digest) {
      if (typeof digest !== 'string' || !modDigest.test(digest)) throw new FileOperationError(400, 'mod-name')
      const entry = (await list()).find((item) => item.digest === digest)
      if (!entry || !modFilename.test(entry.file) || entry.size < 1 || entry.size > maxModBytes) throw new FileOperationError(409, 'mod-staged')
      let bytes
      try {
        bytes = await readFile(join(directory, digest + '.jar'))
      } catch (error) {
        if (error.code === 'ENOENT') throw new FileOperationError(409, 'mod-staged')
        throw error
      }
      if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== digest) throw new FileOperationError(409, 'mod-staged')
      return { file: entry.file, bytes }
    },
    async stage(file, bytes) {
      if (typeof file !== 'string' || !modFilename.test(file)) throw new FileOperationError(400, 'mod-name')
      checkBusy()
      try {
        const digest = createHash('sha256').update(bytes).digest('hex')
        const existing = await list()
        const duplicate = existing.find((item) => item.digest === digest)
        if (duplicate) return duplicate
        if (existing.length >= maxStaged) throw new FileOperationError(409, 'mod-capacity')
        const info = await inspectFabricMod(bytes, versions)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const path = join(directory, digest + '.jar')
        const writer = await open(path, 'wx', 0o600)
        const entry = { digest, file, size: bytes.length, stagedAt: now(), ...info }
        try {
          try {
            await writer.writeFile(bytes)
            await writer.sync()
          } finally {
            await writer.close()
          }
          await writeJson(join(directory, digest + '.json'), entry)
        } catch (error) {
          await rm(path, { force: true })
          throw error
        }
        return entry
      } finally {
        busy = false
      }
    },
    async discard(digest) {
      if (typeof digest !== 'string' || !modDigest.test(digest)) throw new FileOperationError(400, 'mod-name')
      checkBusy()
      try {
        await rm(join(directory, digest + '.json'), { force: true })
        await rm(join(directory, digest + '.jar'), { force: true })
      } finally {
        busy = false
      }
    },
  }
}
