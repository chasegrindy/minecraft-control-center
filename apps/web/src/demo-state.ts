import { useEffect, useReducer, useState } from 'react'
import { actions, demoEvents, demoLogs, demoOnlinePlayers, formatTime, playerLimit, series } from './demo'
import type { Level, Log, ServerAction, WorldEvent } from './demo'

const minute = 60_000
const historyDuration = 24 * 60 * minute
const sampleInterval = 5_000
export const memoryLimit = 8

export type Sample = {
  at: number
  cpu: number
  ram: number
  mspt: number | null
  tps: number | null
}

type DemoState = {
  startedAt: number | null
  pending: ServerAction | null
  sample: Sample
  samples: Sample[]
  count: number
  nextLogId: number
  logs: Log[]
  events: WorldEvent[]
  commands: string[]
  status: string
}

type Action =
  | { type: 'sample'; at: number }
  | { type: 'request'; action: ServerAction }
  | { type: 'finish'; at: number }
  | { type: 'command'; at: number; value: string }

function initialSample(at: number): Sample {
  return { at, cpu: 37, ram: 58, mspt: 24.8, tps: 19.9 }
}

function initialState(at: number): DemoState {
  const sample = initialSample(at)
  const samples = Array.from({ length: 721 }, (_, index): Sample => {
    const seedIndex = (index + 7) % series.cpu.length
    // The last hour follows the shape used in the design prototypes.
    const isLastHour = index >= 693
    const position = isLastHour ? index - 693 : seedIndex
    return {
      ...sample,
      at: at - (720 - index) * 2 * minute,
      cpu: series.cpu[position],
      ram: series.ram[position],
    }
  })
  return {
    startedAt: at - 62 * 60 * minute,
    pending: null,
    sample,
    samples: [...samples.slice(0, -1), sample],
    count: 0,
    nextLogId: 1,
    logs: demoLogs.map((log, index) => ({ ...log, time: formatTime(at - (demoLogs.length - index) * 21_000, true) })),
    events: demoEvents.map((event, index) => ({ ...event, time: formatTime(at - (index + 1) * 5 * minute) })),
    commands: [],
    status: '',
  }
}

function recordSample(state: DemoState, sample: Sample): DemoState {
  const last = state.samples.at(-1)
  const sameBucket = last && Math.floor(last.at / minute) === Math.floor(sample.at / minute)
  const previous = sameBucket ? state.samples.slice(0, -1) : state.samples
  return { ...state, sample, samples: [...previous.filter((entry) => entry.at >= sample.at - historyDuration), sample] }
}

function addLog(state: DemoState, at: number, level: Level, message: string): DemoState {
  return {
    ...state,
    nextLogId: state.nextLogId + 1,
    logs: [...state.logs.slice(-99), { id: 'log-' + state.nextLogId, time: formatTime(at, true), level, message }],
  }
}

function commandResult(value: string): { level: Level; message: string } {
  const [verb, ...args] = value.replace(/^\//, '').split(/\s+/)
  if (verb === 'list' && args.length === 0) {
    return { level: 'INFO', message: 'Gracze online (' + demoOnlinePlayers.length + '/' + playerLimit + '): ' + demoOnlinePlayers.map((player) => player.name).join(', ') }
  }
  if (verb === 'say' && args.length > 0) return { level: 'INFO', message: '[Ogłoszenie demo] ' + args.join(' ') }
  if (verb === 'help' && args.length === 0) return { level: 'INFO', message: 'Komendy demo: list, say <tekst>, help.' }
  return { level: 'WARN', message: 'Komenda niedostępna w symulacji. Wpisz help, aby zobaczyć dostępne polecenia.' }
}

function reduce(state: DemoState, action: Action): DemoState {
  switch (action.type) {
    case 'request': {
      const online = state.startedAt !== null
      if (state.pending || (action.action === 'start' ? online : !online)) return state
      return { ...state, pending: action.action, status: 'Trwa operacja demo: ' + actions[action.action].label + '.' }
    }
    case 'finish': {
      if (!state.pending) return state
      const online = state.pending !== 'stop'
      const message = actions[state.pending].done
      const event: WorldEvent = { id: 'action-' + state.nextLogId, kind: 'action', time: formatTime(action.at), title: message, detail: 'Operacja administratora · symulacja' }
      const updated = recordSample(state, online ? initialSample(action.at) : { at: action.at, cpu: 0, ram: 0, tps: null, mspt: null })
      return {
        ...addLog(updated, action.at, 'INFO', message),
        startedAt: online ? action.at : null,
        pending: null,
        events: [event, ...state.events.slice(0, 49)],
        status: message,
      }
    }
    case 'sample': {
      if (state.startedAt === null || state.pending || action.at <= state.sample.at) return state
      const count = state.count + 1
      const cpu = Math.round(37 + 12 * Math.sin(count * .7))
      const ram = Math.round(57 + 5 * Math.sin(count * .31))
      const mspt = Math.round((22 + cpu * .12) * 10) / 10
      const updated = { ...recordSample(state, { at: action.at, cpu, ram, mspt, tps: cpu > 45 ? 19.8 : 20 }), count }
      return count % 4 === 0 ? addLog(updated, action.at, 'INFO', '[DEMO] Zapisano stan świata.') : updated
    }
    case 'command': {
      const value = action.value.trim()
      if (!value || value.length > 160 || state.startedAt === null || state.pending) return state
      const result = commandResult(value)
      return {
        ...addLog(addLog(state, action.at, 'INFO', '[DEMO] > ' + value), action.at, result.level, result.message),
        commands: [...state.commands.slice(-29), value],
      }
    }
  }
}

export function useDemoServer() {
  const [state, dispatch] = useReducer(reduce, null, () => initialState(Date.now()))
  const [paused, setPaused] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)
  const online = state.startedAt !== null
  const sampling = online && visible && !paused && state.pending === null

  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    if (!sampling) return
    const timer = window.setInterval(() => dispatch({ type: 'sample', at: Date.now() }), sampleInterval)
    return () => window.clearInterval(timer)
  }, [sampling])

  useEffect(() => {
    if (!state.pending) return
    const timer = window.setTimeout(() => dispatch({ type: 'finish', at: Date.now() }), 850)
    return () => window.clearTimeout(timer)
  }, [state.pending])

  return {
    ...state,
    online,
    paused,
    setPaused,
    request: (action: ServerAction) => dispatch({ type: 'request', action }),
    sendCommand: (value: string) => dispatch({ type: 'command', at: Date.now(), value }),
  }
}
