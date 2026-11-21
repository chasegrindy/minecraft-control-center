export type Concept = 'observatory' | 'operator' | 'atlas'
export type View = 'overview' | 'console' | 'players' | 'world' | 'activity' | 'design'
export type ServerAction = 'start' | 'stop' | 'restart'
export type Level = 'INFO' | 'WARN' | 'ERROR' | 'Inne'
export type Dimension = 'overworld' | 'nether' | 'end'

export const concepts = {
  observatory: { name: 'Obserwatorium', detail: 'Zielone akcenty, boczna nawigacja i wykresy na pierwszym planie.' },
  operator: { name: 'Operator', detail: 'Miedziana paleta, górna nawigacja i konsola obok sterowania.' },
  atlas: { name: 'Atlas', detail: 'Chłodna oliwkowa paleta, kompaktowa nawigacja i mapa w centrum.' },
} as const

export const actions = {
  start: { label: 'Uruchom', confirm: 'Uruchomić serwer w symulacji?', done: 'Serwer demo został uruchomiony.' },
  stop: { label: 'Zatrzymaj', confirm: 'Zatrzymać serwer w symulacji?', done: 'Serwer demo został zatrzymany.' },
  restart: { label: 'Restartuj', confirm: 'Zrestartować serwer w symulacji?', done: 'Serwer demo został zrestartowany.' },
} as const

export const players = [
  { name: 'Astra', initials: 'AS', online: true, role: 'Operator', dimension: 'overworld', color: '#92d2ab' },
  { name: 'Mosswalker', initials: 'MW', online: true, role: 'Gracz', dimension: 'overworld', color: '#d6aa79' },
  { name: 'KiteForge', initials: 'KF', online: true, role: 'Gracz', dimension: 'nether', color: '#adabd9' },
  { name: 'Wisp', initials: 'WI', online: true, role: 'Gracz', dimension: 'overworld', color: '#9eb4d0' },
  { name: 'RedstoneFox', initials: 'RF', online: true, role: 'Gracz', dimension: 'end', color: '#d39787' },
  { name: 'Fern', initials: 'FE', online: false, role: 'Gracz', dimension: null, color: '#b4bb84' },
] as const
export const playerLimit = 20
export const demoOnlinePlayers = players.filter((player) => player.online)

export const dimensions: Record<Dimension, string> = {
  overworld: 'Overworld',
  nether: 'Nether',
  end: 'End',
}
export type WorldLocation = { dimension: Dimension; x: number; y: number; z: number }

export type EventKind = 'join' | 'leave' | 'backup' | 'advancement' | 'death' | 'action' | 'boss' | 'dimension'
export type WorldEvent = { id: string; time: string; kind: EventKind; title: string; detail: string }
export const demoEvents: WorldEvent[] = [
  { id: 'e1', time: '14:28', kind: 'join', title: 'Astra dołącza do gry', detail: 'Wejście gracza · Overworld' },
  { id: 'e2', time: '14:17', kind: 'advancement', title: 'Mosswalker zdobywa osiągnięcie', detail: 'Osiągnięcie · Diamenty!' },
  { id: 'e3', time: '14:00', kind: 'backup', title: 'Utworzono kopię zapasową', detail: 'Kopia automatyczna · 1,24 GB' },
  { id: 'e4', time: '13:51', kind: 'death', title: 'KiteForge ginie w Netherze', detail: 'Śmierć gracza · X 120, Z −84' },
  { id: 'e5', time: '13:36', kind: 'leave', title: 'Fern kończy sesję', detail: 'Wyjście gracza · 41 min gry' },
]

export type Log = { id: string; time: string; level: Level; message: string; original?: string; trace?: string[] }
export const demoLogs: Log[] = [
  { id: 'l1', time: '13:55:04', level: 'INFO', message: 'Saving chunks for level minecraft:overworld' },
  { id: 'l2', time: '14:00:27', level: 'INFO', message: 'Automatic backup completed (1.24 GB)' },
  { id: 'l3', time: '14:02:05', level: 'WARN', message: 'Server tick took 61 ms (simulated)' },
  { id: 'l4', time: '14:04:17', level: 'ERROR', message: 'Snapshot validation failed for a test archive (simulated)' },
  { id: 'l5', time: '14:17:12', level: 'INFO', message: 'Mosswalker has made the advancement [Diamonds!]' },
  { id: 'l6', time: '14:28:31', level: 'INFO', message: 'Astra joined the game' },
]

export const series = {
  cpu: [22, 25, 21, 23, 31, 27, 32, 25, 51, 63, 46, 37, 34, 47, 41, 58, 51, 40, 54, 49, 69, 62, 74, 55, 46, 33, 39, 37],
  ram: [42, 43, 43, 43, 44, 45, 45, 47, 47, 47, 48, 47, 49, 50, 51, 51, 52, 52, 54, 53, 54, 55, 55, 56, 57, 58, 59, 58],
}

export const markers: Record<Dimension, { name: string; position: string; x: number; y: number; type: 'point' | 'player' }[]> = {
  overworld: [
    { name: 'Punkt startowy', position: 'X 0 / Z 0', x: 48, y: 56, type: 'point' },
    { name: 'Astra', position: 'X 128 / Z −64', x: 68, y: 38, type: 'player' },
    { name: 'Farma nad rzeką', position: 'X −152 / Z 110', x: 25, y: 72, type: 'point' },
  ],
  nether: [{ name: 'KiteForge', position: 'X 120 / Z −84', x: 62, y: 36, type: 'player' }],
  end: [{ name: 'RedstoneFox', position: 'X 94 / Z 28', x: 57, y: 55, type: 'player' }],
}

const timeFormat = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' })
const secondsFormat = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function formatTime(timestamp: number, seconds = false) {
  return (seconds ? secondsFormat : timeFormat).format(timestamp)
}
