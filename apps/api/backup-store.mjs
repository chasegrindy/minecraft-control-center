import { constants } from 'node:fs'
import { open, readFile, readdir, realpath } from 'node:fs/promises'
import { child } from './file-manager.mjs'

const legacy = /^fabric-before-crafty-(\d{4})(\d{2})(\d{2})$/
const scheduled = /^crafty-(\d{4}-\d{2}-\d{2})_([01]\d|2[0-3])-([0-5]\d)-([0-5]\d)$/
const legacySuffix = '.tar.age.verified.json'
const digest = /^[a-f0-9]{64}$/

function details(id) {
  if (typeof id !== 'string') return null
  const old = id.match(legacy)
  const crafty = id.match(scheduled)
  if (!old && !crafty) return null
  const sourceDate = old ? old.slice(1).join('-') : crafty[1]
  const parsed = new Date(sourceDate + 'T00:00:00Z')
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== sourceDate) return null
  const sortKey = sourceDate + (crafty?.slice(2).join('') ?? '')
  return { sourceDate, sortKey, format: old ? 'tar.age' : 'zip.age' }
}

export const validArchiveId = (id) => details(id) !== null

export function makeBackupStore(directory) {
  async function find(id) {
    const format = details(id)
    if (!format) return null
    try {
      const catalog = await realpath(directory)
      const zip = format.format === 'zip.age'
      const root = zip ? (await child(catalog, id, 'directory'))?.path : catalog
      if (!root) return null
      const name = id + '.' + format.format
      const [record, artifact] = await Promise.all([
        child(root, zip ? 'verified.json' : id + legacySuffix, 'file'),
        child(root, zip ? 'archive.zip.age' : name, 'file'),
      ])
      if (!record || !artifact || artifact.info.nlink !== 1 || record.info.size > 8192) return null
      let metadata
      try {
        metadata = JSON.parse(await readFile(record.path, 'utf8'))
      } catch (error) {
        if (error instanceof SyntaxError) return null
        throw error
      }
      const verified = typeof metadata?.verifiedAt === 'string' ? Date.parse(metadata.verifiedAt) : NaN
      if (!metadata || metadata.source !== id || metadata.sourceDate !== format.sourceDate
        || !Number.isFinite(verified) || artifact.info.mtimeMs > verified + 2000
        || metadata.size !== artifact.info.size || metadata.size <= 0
        || typeof metadata.encryptedSha256 !== 'string' || !digest.test(metadata.encryptedSha256)
        || !Number.isInteger(metadata.files) || metadata.files <= 0
        || (zip && (typeof metadata.sourceSha256 !== 'string' || !digest.test(metadata.sourceSha256)))) return null
      const { sourceDate, verifiedAt, size, files, encryptedSha256 } = metadata
      return { values: { id, sourceDate, verifiedAt, size, files, encryptedSha256, format: format.format },
        name, artifact, sourceSha256: zip ? metadata.sourceSha256 : null }
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  return {
    async list() {
      let names
      try {
        names = await readdir(directory)
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      const ids = names.map((name) => name.endsWith(legacySuffix) ? name.slice(0, -legacySuffix.length) : name)
      const indexed = [...new Set(ids)].map((id) => ({ id, format: details(id) })).filter(({ format }) => format)
        .sort((a, b) => b.format.sortKey.localeCompare(a.format.sortKey))
      const records = await Promise.all(indexed.slice(0, 100).map(({ id }) => find(id)))
      return records.filter(Boolean).map(({ values }) => values)
    },
    async download(id) {
      const record = await find(id)
      if (!record) return null
      const handle = await open(record.artifact.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const observed = await handle.stat().catch(async (error) => {
        await handle.close()
        throw error
      })
      const { info } = record.artifact
      if (!observed.isFile() || observed.nlink !== 1 || observed.ino !== info.ino || observed.dev !== info.dev
        || observed.size !== record.values.size || observed.mtimeMs !== info.mtimeMs) {
        await handle.close()
        return null
      }
      return { name: record.name, size: record.values.size, stream: handle.createReadStream(),
        encryptedSha256: record.values.encryptedSha256, sourceSha256: record.sourceSha256 }
    },
  }
}
