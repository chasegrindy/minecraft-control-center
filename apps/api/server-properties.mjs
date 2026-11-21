import { createHash } from 'node:crypto'

export const propertyFields = Object.freeze({
  motd: { type: 'text', max: 200 },
  'max-players': { type: 'integer', min: 0, max: 2_147_483_647 },
  difficulty: { type: 'choice', options: ['peaceful', 'easy', 'normal', 'hard'] },
  'allow-flight': { type: 'boolean' },
  'view-distance': { type: 'integer', min: 2, max: 32 },
  'simulation-distance': { type: 'integer', min: 2, max: 32 },
})

function validValue(field, value) {
  if (field.type === 'boolean') return typeof value === 'boolean'
  if (field.type === 'choice') return field.options.includes(value)
  if (field.type === 'integer') return Number.isSafeInteger(value) && value >= field.min && value <= field.max
  return typeof value === 'string' && value.length <= field.max && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
}

export function validPropertyChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false
  const entries = Object.entries(changes)
  return entries.length > 0 && entries.every(([key, value]) => Object.hasOwn(propertyFields, key) && validValue(propertyFields[key], value))
}

function unescape(part) {
  return part.replace(/\\(?:u([a-fA-F0-9]{4})|([^\r\n]))/g, (_, code, escaped) => code
    ? String.fromCharCode(parseInt(code, 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' })[escaped] ?? escaped)
}

function parseLines(text) {
  const physical = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? []
  const logical = []
  for (let index = 0; index < physical.length; index++) {
    let raw = physical[index]
    let combined = raw.replace(/[\r\n]+$/, '').replace(/^[ \t\f]+/, '')
    if (!combined || /^[#!]/.test(combined)) {
      logical.push({ raw })
      continue
    }
    while (((combined.match(/\\+$/)?.[0].length ?? 0) % 2) && index + 1 < physical.length) {
      raw += physical[++index]
      combined = combined.slice(0, -1) + physical[index].replace(/[\r\n]+$/, '').replace(/^[ \t\f]+/, '')
    }
    const match = combined.match(/^((?:\\.|[^=:\s\\])+)[ \t\f]*(?:[=:][ \t\f]*)?(.*)$/)
    logical.push(match ? { raw, key: unescape(match[1]), value: match[2] } : { raw })
  }
  return logical
}

function decoded(raw) {
  const bytes = Buffer.from(raw, 'latin1')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return raw }
}

function readValue(raw, field) {
  const value = unescape(decoded(raw))
  const typed = field.type === 'boolean' ? ({ true: true, false: false })[value.trim()]
    : field.type === 'integer' ? (/^-?\d+$/.test(value.trim()) ? Number(value) : null) : value
  return validValue(field, typed) ? typed : null
}

export function inspectProperties(bytes) {
  const values = Object.fromEntries(Object.keys(propertyFields).map((key) => [key, null]))
  const lines = parseLines(bytes.toString('latin1'))
  const present = new Set()
  for (const { key, value } of lines) {
    if (key && Object.hasOwn(propertyFields, key)) {
      present.add(key)
      values[key] = readValue(value, propertyFields[key])
    }
  }
  return { revision: createHash('sha256').update(bytes).digest('hex'), values, invalid: [...present].filter((key) => values[key] === null) }
}

function configuredValue(bytes, name) {
  const entry = parseLines(bytes.toString('latin1')).findLast(({ key }) => key === name)
  return entry ? unescape(decoded(entry.value)) : null
}

export function configuredWorld(bytes) {
  return configuredValue(bytes, 'level-name') ?? 'world'
}

export function configuredWhitelist(bytes) {
  const value = configuredValue(bytes, 'white-list')?.trim().toLowerCase()
  return value === 'true' ? true : value === 'false' ? false : null
}

function encoded(value) {
  return String(value).replace(/[\\ ]|[^\x21-\x7e]/g, (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
}

export function applyProperties(bytes, changes) {
  const source = bytes.toString('latin1')
  const newline = source.match(/\r\n|\n|\r/)?.[0] ?? '\n'
  const lines = parseLines(source)
  const last = new Map()
  lines.forEach(({ key }, index) => { if (key) last.set(key, index) })
  let result = lines.map((line, index) => {
    if (!line.key || !Object.hasOwn(changes, line.key)) return line.raw
    const value = changes[line.key]
    if (value === null) return ''
    return last.get(line.key) === index ? line.key + '=' + encoded(value) + newline : line.raw
  }).join('')
  for (const [name, value] of Object.entries(changes)) {
    if (last.has(name) || value === null) continue
    if (result && !/[\r\n]$/.test(result)) result += newline
    result += name + '=' + encoded(value) + newline
  }
  return Buffer.from(result, 'latin1')
}
