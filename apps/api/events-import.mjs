import { lstat, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { normalizeLogs } from './crafty.mjs'
import { makeEventStore, normalizeLogEvents, parseServerEvent } from './world-events.mjs'

async function readDatedLogs() {
  const source = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const events = []
  for await (const entry of source) {
    const match = entry.match(/^(\d{4}-\d{2}-\d{2})\t(.{1,1800})$/)
    if (!match) continue
    const [, date, raw] = match
    const utcDay = Date.parse(date + 'T00:00:00Z')
    if (!Number.isFinite(utcDay) || new Date(utcDay).toISOString().slice(0, 10) !== date) continue
    const [line] = normalizeLogs([raw])
    const event = parseServerEvent(line, utcDay)
    if (event) events.push(event)
    if (events.length >= 10_000) throw new Error('Za dużo zdarzeń w jednym imporcie.')
  }
  return events
}

const args = process.argv.slice(2)
let events
if (args.length === 0) {
  events = await readDatedLogs()
} else if (args.length === 2 && args[0] === '--snapshot') {
  const input = await lstat(args[1])
  if (!input.isFile() || input.size > 256 * 1024) throw new Error('Nieprawidłowa migawka wydarzeń.')
  events = normalizeLogEvents(JSON.parse(await readFile(args[1], 'utf8')))
} else {
  throw new Error('Użyj stdin z datowanymi logami lub podaj --snapshot <plik JSON>.')
}
if (!events.length) throw new Error('Brak rozpoznanych zdarzeń w danych wejściowych.')
const saved = await makeEventStore().append(events)
console.log('Rozpoznane zdarzenia: ' + events.length + '. Zapisane w MCC: ' + saved.length + '.')
