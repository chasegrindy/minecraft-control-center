import { useEffect, useMemo, useState } from 'react'
import { LocateFixed, Search } from 'lucide-react'
import { Button, Notice, PanelHeading, ServerStatus } from './ui'
import { positionDimensions, usePlayerPositions } from './player-positions'
import type { PlayerMapTarget } from './player-positions'

export type PlayerEvent = { type: string; player: string; time: number }
type Profile = {
  name: string
  uuid: string | null
  whitelisted?: boolean | null
  operator?: boolean | null
  operatorLevel?: number | null
  banned?: boolean | null
  statistics?: { playTicks: number; deaths: number; mobKills: number }
}
type Directory = {
  capturedAt: number | null
  whitelistEnabled: boolean | null
  players: Profile[]
  access?: { source: 'live' | 'snapshot' | 'unavailable'; at: number | null }
  livePositions?: boolean
}
type Presence = 'online' | 'offline' | 'unknown'
type Player = Profile & { status: Presence; sharedName: boolean }
type Session = { joined: number | null; left: number | null }
const dateFormat = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' })
const noDirectory: Directory = { capturedAt: null, whitelistEnabled: null, players: [] }
const wornSlots = { head: 'Głowa', chest: 'Tułów', legs: 'Nogi', feet: 'Stopy', offhand: 'Druga ręka' } as const
type Slot = number | keyof typeof wornSlots
type Inventory = { savedAt: number; items: { slot: Slot; id: string; count: number }[] }
const slotOrder = (slot: Slot) => typeof slot === 'number' ? slot : 36 + Object.keys(wornSlots).indexOf(slot)

function slotName(slot: Slot) {
  if (typeof slot !== 'number') return wornSlots[slot]
  return slot < 9 ? 'Pasek · ' + (slot + 1) : 'Plecak · ' + (slot - 8)
}

function SavedInventory({ uuid, verifySession }: { uuid: string; verifySession: () => Promise<void> }) {
  const [inventory, setInventory] = useState<Inventory | null | undefined>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/mcc/players/' + encodeURIComponent(uuid) + '/inventory', { signal: controller.signal })
        if (response.status === 401) await verifySession()
        if (response.status === 404) {
          if (!controller.signal.aborted) setInventory(null)
          return
        }
        if (!response.ok) throw new Error('Inventory unavailable')
        const result = await response.json() as Inventory
        if (!controller.signal.aborted) setInventory(result)
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
    }
    void load()
    return () => controller.abort()
  }, [uuid, verifySession])

  if (failed) return <p role="status">Nie udało się odczytać zapisu ekwipunku.</p>
  if (inventory === undefined) return <p role="status">Wczytywanie zapisu ekwipunku…</p>
  if (inventory === null) return <p role="status">Brak zapisu ekwipunku tego gracza w MCC.</p>
  const items = [...inventory.items].sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot))
  return <>
    <p className="player-source">Zapis gry z <time dateTime={new Date(inventory.savedAt).toISOString()}>{dateFormat.format(inventory.savedAt)}</time></p>
    {items.length ? <ul className="inventory-items" aria-label="Przedmioty z zapisu">{items.map(({ slot, id, count }) => <li key={slot}>
      <span>{slotName(slot)}</span><code>{id}</code><span><span className="visually-hidden">Liczba sztuk </span>×{count}</span>
    </li>)}</ul> : <p>W zapisanym ekwipunku brak przedmiotów.</p>}
  </>
}

function PlayerInventory({ uuid, verifySession }: { uuid: string; verifySession: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false)
  return <details className="player-inventory" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>Zapisany ekwipunek</summary>
    {expanded && <SavedInventory uuid={uuid} verifySession={verifySession} />}
  </details>
}

function sessionHistory(events: PlayerEvent[], name: string) {
  const ordered = events.filter((event) => event.player === name && ['join', 'leave'].includes(event.type))
    .sort((a, b) => a.time - b.time)
  const history: Session[] = []
  let joined: number | null = null
  for (const event of ordered) {
    if (event.type === 'join') {
      if (joined !== null) history.push({ joined, left: null })
      joined = event.time
    } else {
      history.push({ joined, left: event.time })
      joined = null
    }
  }
  if (joined !== null) history.push({ joined, left: null })
  return history.reverse()
}

function showDuration(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000)
  if (!minutes) return '< 1 min'
  if (minutes < 60) return minutes + ' min'
  return Math.floor(minutes / 60) + ' h ' + minutes % 60 + ' min'
}

export function PlayerDirectory({ names, online, max, knownStatus, events, verifySession, operator, onLocate }: {
  names: string[]
  online: number | null
  max: number | null
  knownStatus: boolean
  events: PlayerEvent[]
  verifySession: () => Promise<void>
  operator: boolean
  onLocate?: (player: PlayerMapTarget) => void
}) {
  const [directory, setDirectory] = useState<Directory>(noDirectory)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<'all' | Presence>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(30)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const positions = usePlayerPositions(Boolean(onLocate) && directory.livePositions === true && selectedKey !== null, verifySession)
  useEffect(() => {
    const controller = new AbortController()
    let watch = false
    let timer: number | undefined
    async function read() {
      try {
        const response = await fetch('/api/mcc/players', { signal: controller.signal })
        if (response.status === 401) await verifySession()
        if (!response.ok) throw new Error('Player directory unavailable')
        const result = await response.json() as Directory
        if (controller.signal.aborted) return
        watch = result.access !== undefined
        setDirectory(result)
        setFailed(false)
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      } finally {
        if (watch && !controller.signal.aborted) timer = window.setTimeout(() => void read(), 5000)
      }
    }
    void read()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [verifySession])

  const players = useMemo(() => {
    const profiles = [...directory.players]
    const known = new Set(profiles.map(({ name }) => name.toLowerCase()))
    for (const name of [...names, ...events.map(({ player }) => player)]) {
      const key = name.toLowerCase()
      if (known.has(key)) continue
      profiles.push({ name, uuid: null })
      known.add(key)
    }
    const counts = new Map<string, number>()
    for (const { name } of profiles) {
      const key = name.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const sample = new Set(names.map((name) => name.toLowerCase()))
    const fullSample = knownStatus && online !== null && names.length === online
    return profiles.map((player): Player => {
      const key = player.name.toLowerCase()
      const sharedName = (counts.get(key) ?? 0) > 1
      const status = knownStatus && sample.has(key) ? sharedName ? 'unknown' : 'online' : fullSample ? 'offline' : 'unknown'
      return { ...player, sharedName, status }
    }).sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online') || a.name.localeCompare(b.name, 'pl'))
  }, [directory, events, names, knownStatus, online])
  const selected = players.find((player) => (player.uuid ?? player.name) === selectedKey)
  const selectedUuid = selected?.uuid?.replaceAll('-', '')
  const matchingPositions = selected && positions.health === 'ok' ? positions.positions.filter((position) =>
    selectedUuid ? position.uuid === selectedUuid : !selected.sharedName && selected.name.toLowerCase() === position.name.toLowerCase()) : []
  const location = matchingPositions.length === 1 ? matchingPositions[0] : null
  const history = useMemo(() => selected && !selected.sharedName ? sessionHistory(events, selected.name) : [], [events, selected])
  const complete = history.filter(({ joined, left }) => joined !== null && left !== null)
  const total = complete.reduce((sum, { joined, left }) => sum + Math.max(0, (left ?? 0) - (joined ?? 0)), 0)
  const needle = query.trim().toLowerCase()
  const filtered = players.filter((player) => (filter === 'all' || filter === player.status) && player.name.toLowerCase().includes(needle))
  const count = !knownStatus || online === null ? 'Status w grze niedostępny' : online + ' online' + (max === null ? '' : ' / ' + max)
  const access = directory.access
  const accessLabel = access?.source === 'live' ? 'Uprawnienia z plików serwera'
    : directory.capturedAt === null ? null : 'Migawka profili z ' + dateFormat.format(directory.capturedAt)

  return <>
    <section className="panel" aria-label="Lista graczy">
      <PanelHeading title="Lista graczy" description={count} />
      <div className="console-tools player-directory-tools">
        <label className="search"><Search size={16} aria-hidden="true" />
          <input aria-label="Szukaj gracza" placeholder="Szukaj gracza" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(30) }} />
        </label>
        <select aria-label="Status gracza" value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setLimit(30) }}>
          <option value="all">Wszyscy</option><option value="online">Online</option><option value="offline">Offline</option><option value="unknown">Brak potwierdzenia</option>
        </select>
      </div>
      {failed && <Notice title="Szczegóły profili są niedostępne" />}
      {access?.source === 'unavailable' && <p className="player-source">Odczyt uprawnień z plików serwera niedostępny</p>}
      {accessLabel && <p className="player-source">
        {accessLabel}
        {directory.whitelistEnabled !== null && ' · Whitelista ' + (directory.whitelistEnabled ? 'włączona' : 'wyłączona')}
      </p>}
      {filtered.length ? <ul className="players-list roster-list">
        {filtered.slice(0, limit).map((player) => {
          const key = player.uuid ?? player.name
          const access = [player.operator && (player.operatorLevel === null ? 'OP' : 'OP ' + player.operatorLevel),
            player.whitelisted && 'Whitelista', player.banned && 'Ban'].filter(Boolean).join(' · ')
          return <li key={key}>
            <span className="avatar" aria-hidden="true">{player.name.slice(0, 2).toUpperCase()}</span>
            <div><strong>{player.name}</strong>{player.uuid && <span>{player.uuid}</span>}{access && <span>{access}</span>}</div>
            {player.status === 'unknown' ? <span className="player-unknown">Bez potwierdzenia</span> : <ServerStatus online={player.status === 'online'} />}
            <Button onClick={() => setSelectedKey(key)} aria-pressed={selectedKey === key}
              aria-label={'Historia sesji: ' + player.name + (player.sharedName ? ' · ' + player.uuid : '')}>Historia sesji</Button>
          </li>
        })}
      </ul> : <p className="empty-state">{players.length ? 'Brak graczy pasujących do filtra.' : 'Brak profili i zarejestrowanych graczy.'}</p>}
      {filtered.length > limit && <Button className="roster-more" onClick={() => setLimit((value) => value + 30)}>Pokaż kolejnych</Button>}
    </section>
    {selected && <section className="panel" aria-label="Historia sesji gracza">
      <PanelHeading title={'Aktywność · ' + selected.name} description="Statystyki i sesje Minecrafta" />
      {location && onLocate && <div className="world-map-actions">
        <p className="player-source">Pozycja na żywo · {positionDimensions[location.dimension]} · X {location.x} · Y {location.y} · Z {location.z}</p>
        <Button onClick={() => onLocate({ uuid: location.uuid, name: location.name, seenAt: positions.updatedAt ?? 0 })}>
          <LocateFixed size={16} aria-hidden="true" /> Pokaż na mapie
        </Button>
      </div>}
      {selected.statistics && <p className="player-source">Zapis gry · Czas {showDuration(selected.statistics.playTicks * 50)}
        {' · Śmierci ' + selected.statistics.deaths + ' · Zabite moby ' + selected.statistics.mobKills}</p>}
      {operator && selected.uuid && <PlayerInventory key={selected.uuid} uuid={selected.uuid} verifySession={verifySession} />}
      {complete.length > 0 && <p className="player-source">Zmierzony czas gry {showDuration(total)} · Sesje z wejściem i wyjściem {complete.length}</p>}
      {selected.sharedName ? <p className="empty-state">Ten nick jest powiązany z kilkoma UUID. W logach sesji zapisana jest tylko nazwa.</p>
        : history.length ? <ul className="session-list">
        {history.slice(0, 10).map(({ joined, left }) => <li key={String(joined) + '/' + String(left)}>
          <span>{joined === null ? 'Wejście nieodnotowane' : 'Wejście ' + dateFormat.format(joined)}</span>
          <span>{left === null ? 'Wyjście nieodnotowane' : 'Wyjście ' + dateFormat.format(left)}</span>
          {joined !== null && left !== null && <strong>{showDuration(left - joined)}</strong>}
        </li>)}
      </ul> : <p className="empty-state">Brak wpisów o sesjach tego gracza w dostępnej historii.</p>}
    </section>}
  </>
}
