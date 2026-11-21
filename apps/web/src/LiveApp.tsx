import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ChevronRight, Clock3, Cpu, ExternalLink, Folder, HardDrive, LayoutDashboard, Map as MapIcon, MemoryStick, Terminal, Timer, Users } from 'lucide-react'
import type { Dimension, Log, WorldLocation } from './demo'
import { dimensions, formatTime } from './demo'
import { Brand, Button, Notice, PanelHeading, ServerStatus } from './ui'
import { ConsoleView } from './Views'
import { SessionGate } from './SessionGate'
import type { Account } from './SessionGate'
import { PowerPanel } from './PowerPanel'
import { EventList } from './Dashboard'
import BackupView from './BackupView'
import CraftyBackups from './CraftyBackups'
import { CommandConfirmation, CommandStatus, PlayerControls, WorldControls, useGameCommands } from './GameCommands'
import { PlayerDirectory } from './LivePlayers'
import { MetricHistory } from './MetricHistory'
import { PushSettings } from './PushSettings'
import { useFeed } from './live-feed'
import type { Connection } from './live-feed'
import type { PlayerMapTarget } from './player-positions'

const WorldMap = lazy(() => import('./WorldMap'))
const FileView = lazy(() => import('./FileView'))

type Snapshot = {
  time: number
  cpu: number | null
  ram: number | null
  running: boolean
  reachable: boolean
  startedAt: number | null
  version: string | null
  memoryBytes: number | null
  online: number | null
  max: number | null
  players: string[]
  tickMetrics?: { tps: number; mspt: number } | null
}
type Stats = Connection & { name: string; snapshot: Snapshot | null; checkedAt?: number; tickMetricsEnabled?: boolean; craftyTerminal?: string }
type Logs = Connection & { lines: string[] }
const eventLabels = { join: 'Dołączenie', leave: 'Wyjście', advancement: 'Osiągnięcie', death: 'Śmierć', boss: 'Pokonanie bossa', dimension: 'Zmiana wymiaru' } as const
type LiveEventKind = keyof typeof eventLabels
type LiveEvent = { id: string; type: LiveEventKind; time: number; player: string; detail: string | null;
  fromDimension?: Dimension; toDimension?: Dimension; boss?: 'wither';
  location?: WorldLocation }
type ActivityFeed = Connection & { events: LiveEvent[]; archiveUnavailable: boolean;
  fabricStatus?: 'disabled' | 'waiting' | 'ok' | 'error'; fabricSkipped?: number }

const loadingStats: Stats = { health: 'loading', updatedAt: null, name: 'Minecraft', snapshot: null }
const loadingLogs: Logs = { health: 'loading', updatedAt: null, lines: [] }
const loadingActivity: ActivityFeed = { health: 'loading', updatedAt: null, events: [], archiveUnavailable: false }

const nav = {
  overview: { title: 'Przegląd', icon: LayoutDashboard },
  console: { title: 'Konsola', icon: Terminal },
  players: { title: 'Gracze', icon: Users },
  world: { title: 'Mapa świata', icon: MapIcon },
  activity: { title: 'Wydarzenia', icon: Activity },
  files: { title: 'Pliki', icon: Folder },
  backups: { title: 'Kopie', icon: HardDrive },
} as const
type LiveView = keyof typeof nav

function getView(canManage: boolean): LiveView {
  const slug = window.location.hash.split('/')[1]
  if (slug === 'backups' || slug === 'files') return canManage ? slug : 'overview'
  return slug === 'console' || slug === 'players' || slug === 'world' || slug === 'activity' ? slug : 'overview'
}

const number = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 })
const showNumber = (value: number | null | undefined) => value == null ? '—' : number.format(value)

function uptime(snapshot: Snapshot | null) {
  if (!snapshot || snapshot.startedAt === null) return '—'
  const minutes = Math.max(0, Math.floor((snapshot.time - snapshot.startedAt) / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours >= 24 ? Math.floor(hours / 24) + ' d ' + hours % 24 + ' h' : hours + ' h ' + minutes % 60 + ' min'
}

function ConnectionNotice({ state, resource, gameStatus }: { state: Connection; resource: string; gameStatus?: boolean }) {
  if (state.health === 'ok') return null
  return (
    <div role="status">
      {state.health === 'loading'
        ? <Notice title={'Łączenie z Crafty'}>Trwa odczyt {resource}.</Notice>
        : <Notice title={'Brak aktualnych danych z Crafty'} tone="error">
          {gameStatus && 'Aktualny stan gry jest nieznany. '}
          {state.updatedAt ? 'Pokazujemy ostatni udany odczyt. ' : ''}Ponawiamy połączenie.
          {document.documentElement.dataset.mccPrivate !== 'true' && ' Sprawdź lokalny tunel PuTTY i API MCC.'}
        </Notice>}
    </div>
  )
}

function CraftyTerminalLink({ href }: { href: string }) {
  return <a className="button secondary" href={href} target="_blank" rel="noopener noreferrer">
    <ExternalLink size={16} aria-hidden="true" /> Terminal w Crafty
  </a>
}

function LiveMetrics({ state }: { state: Stats }) {
  const { snapshot } = state
  const cards = [
    { label: 'Gracze online', Icon: Users, value: showNumber(snapshot?.online), unit: snapshot?.max == null ? '' : '/ ' + snapshot.max, detail: 'Odpowiedź Minecrafta' },
    { label: 'Użycie CPU', Icon: Cpu, value: showNumber(snapshot?.cpu), unit: '%', detail: 'Proces jako udział CPU hosta' },
    { label: 'Pamięć RAM', Icon: MemoryStick, value: showNumber(snapshot?.memoryBytes == null ? null : snapshot.memoryBytes / 2 ** 30), unit: 'GiB', detail: snapshot?.ram == null ? 'Pamięć procesu' : number.format(snapshot.ram) + '% RAM hosta' },
    { label: 'Czas działania', Icon: Clock3, value: uptime(snapshot), unit: '', detail: 'Od startu procesu' },
  ]
  if (state.tickMetricsEnabled) {
    const reading = state.health === 'ok' ? snapshot?.tickMetrics : null
    const detail = reading ? 'Średnia z 1 min · spark'
      : state.health === 'loading' ? 'Oczekiwanie na pomiar'
      : state.health === 'ok' && snapshot?.running === false ? 'Serwer zatrzymany'
      : state.health === 'ok' && snapshot?.online === 0 ? 'Pomiar podczas gry'
      : 'Pomiar niedostępny'
    cards.push(
      { label: 'TPS', Icon: Activity, value: showNumber(reading?.tps), unit: '', detail },
      { label: 'MSPT', Icon: Timer, value: showNumber(reading?.mspt), unit: 'ms', detail },
    )
  }
  return <section className={'metrics live-metrics' + (state.tickMetricsEnabled ? ' with-ticks' : '')} aria-label="Metryki bieżące serwera">
    {cards.map(({ label, Icon, value, unit, detail }) => <article className="metric" key={label}>
      <div className="metric-label"><Icon size={17} aria-hidden="true" />{label}</div>
      <div className="metric-value">{value}{value !== '—' && <span>{unit}</span>}</div>
      <div className="metric-bottom">{detail}</div>
    </article>)}
  </section>
}

const logHeader = /^\[(\d{2}:\d{2}:\d{2})(?:\.\d+)?\]\s*\[[^\]]*?\/(INFO|WARN|ERROR|FATAL)\]:\s*(.*)$/
const javaTraceLine = /^(?:\s+at\s|\s+\.\.\. \d+ (?:more|common frames omitted)\b|\s*(?:Caused by|Suppressed):\s|[\w.$]+(?:Error|Exception|Throwable)(?::|$))/

function parseLogs(lines: string[]): Log[] {
  const logs: Log[] = []
  let exception: Log | undefined
  lines.forEach((line, index) => {
    const parts = line.match(logHeader)
    if (!parts && exception && javaTraceLine.test(line)) {
      (exception.trace ??= []).push(line)
      return
    }
    const level = parts?.[2]
    const log: Log = {
      id: index + ':' + line,
      time: parts?.[1] ?? '—',
      level: level === 'INFO' || level === 'WARN' ? level : level === 'ERROR' || level === 'FATAL' ? 'ERROR' : 'Inne',
      message: parts?.[3] ?? line,
      original: line,
    }
    logs.push(log)
    exception = log.level === 'WARN' || log.level === 'ERROR' ? log : undefined
  })
  return logs
}

function LiveConsole({ verifySession, commands, operator, running }: {
  verifySession: () => Promise<void>
  commands: ReturnType<typeof useGameCommands>
  operator: boolean
  running: boolean
}) {
  const state = useFeed('/api/mcc/logs', loadingLogs, verifySession)
  const logs = useMemo(() => parseLogs(state.lines), [state.lines])
  return <>
    <ConnectionNotice state={state} resource="logów" />
    <ConsoleView live={commands.enabled} logs={logs} emptyText={state.health === 'loading' ? 'Pobieranie logów…' : 'Brak odebranych wpisów.'}
      online={running} pending={commands.busy} commands={commands.history} onCommand={commands.canManage ? commands.request : undefined}
      onList={commands.listOnly ? () => commands.request('list') : undefined} />
    {operator && <CommandStatus commands={commands} />}
  </>
}

const eventTime = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
})
const visitTime = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
const activityDay = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'short' })

type ActivityRow = { id: string; latest: LiveEvent; presence?: LiveEvent[] }

function groupActivity(events: LiveEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  const presenceByDay = new Map<string, LiveEvent[]>()
  for (const event of events) {
    if (event.type !== 'join' && event.type !== 'leave') {
      rows.push({ id: event.id, latest: event })
      continue
    }
    const id = 'presence:' + activityDay.format(event.time) + ':' + event.player.toLowerCase()
    const presence = presenceByDay.get(id)
    if (presence) {
      presence.push(event)
    } else {
      const entries = [event]
      presenceByDay.set(id, entries)
      rows.push({ id, latest: event, presence: entries })
    }
  }
  return rows
}

function LiveActivity({ verifySession, compact = false, onLocate }: {
  verifySession: () => Promise<void>; compact?: boolean; onLocate?: (location: WorldLocation) => void
}) {
  const state = useFeed('/api/mcc/activity', loadingActivity, verifySession)
  const [kind, setKind] = useState<LiveEventKind | 'all'>('all')
  const [limit, setLimit] = useState(30)
  const grouped = useMemo(() => groupActivity(state.events.filter((event) => kind === 'all' || event.type === kind)), [state.events, kind])
  const visible = grouped.slice(0, compact ? 4 : limit).map(({ id, latest, presence }) => {
    const { type, time, player, detail, fromDimension, toDimension, boss, location } = latest
    if (presence && presence.length > 1) {
      const joins = presence.filter((event) => event.type === 'join').length
      const leaves = presence.length - joins
      return {
        id,
        kind: 'presence' as const,
        title: player + ' · aktywność',
        detail: [joins && 'Wejścia ' + joins, leaves && 'Wyjścia ' + leaves].filter(Boolean).join(' · '),
        time: eventTime.format(time),
        dateTime: new Date(time).toISOString(),
        visits: compact ? undefined : presence.map((event) => ({
          id: event.id, label: eventLabels[event.type], time: visitTime.format(event.time), dateTime: new Date(event.time).toISOString(),
        })),
      }
    }
    const route = fromDimension && toDimension ? dimensions[fromDimension] + ' → ' + dimensions[toDimension] : null
    const position = location && onLocate ? (route ? '' : dimensions[location.dimension] + ' · ')
      + 'X ' + location.x + ' · Y ' + location.y + ' · Z ' + location.z : null
    return {
      id,
      kind: type,
      title: type === 'join' ? player + ' dołącza do gry'
        : type === 'leave' ? player + ' opuszcza grę'
        : type === 'death' ? 'Śmierć gracza ' + player
        : type === 'boss' ? player + (boss === 'wither' ? ' · pokonanie Withera' : ' · pokonanie Smoka Endu')
        : type === 'dimension' ? player + ' zmienia wymiar'
        : player + ' zdobywa osiągnięcie',
      detail: [route, detail, position].filter(Boolean).join(' · ') || 'Minecraft',
      time: eventTime.format(time),
      dateTime: new Date(time).toISOString(),
      showOnMap: !compact && onLocate && location ? () => onLocate(location) : undefined,
    }
  })

  return <section className="panel activity-panel live-activity" aria-label="Oś czasu świata">
    <PanelHeading title={compact ? 'Ostatnia aktywność' : 'Oś czasu świata'}
      description={state.fabricStatus === 'ok' ? 'Zdarzenia z gry, logi i osiągnięcia Minecrafta' : 'Logi i zapis osiągnięć Minecrafta'}>
      {compact ? <a className="button secondary" href="#observatory/activity">Otwórz oś czasu</a>
        : <label className="activity-filter">Typ zdarzenia
          <select value={kind} onChange={(event) => { setKind(event.target.value as LiveEventKind | 'all'); setLimit(30) }}>
            <option value="all">Wszystkie</option>
            {Object.entries(eventLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>}
    </PanelHeading>
    <ConnectionNotice state={state} resource="zdarzeń" />
    {state.archiveUnavailable && <Notice title="Zapis historii jest chwilowo niedostępny" tone="error" />}
    {!compact && state.fabricStatus === 'waiting' && <Notice title="Oczekiwanie na dziennik zdarzeń Fabric" />}
    {!compact && state.fabricStatus === 'error' && <Notice title="Odczyt dziennika Fabric jest niedostępny" tone="error" />}
    {!compact && (state.fabricSkipped ?? 0) > 0 && <p className="empty-state" role="status">Pominięte wpisy dziennika Fabric · {state.fabricSkipped}</p>}
    {visible.length ? <EventList events={visible} /> : state.health === 'ok' && <p className="empty-state">Brak zdarzeń do wyświetlenia.</p>}
    {!compact && grouped.length > limit && <Button onClick={() => setLimit((previous) => previous + 30)}>Pokaż starsze</Button>}
  </section>
}

function LivePlayers({ snapshot, knownStatus, verifySession, operator, onLocate }: {
  snapshot: Snapshot | null
  knownStatus: boolean
  verifySession: () => Promise<void>
  operator: boolean
  onLocate?: (player: PlayerMapTarget) => void
}) {
  const activity = useFeed('/api/mcc/activity', loadingActivity, verifySession)
  return <PlayerDirectory names={snapshot?.players ?? []} online={snapshot?.online ?? null}
    max={snapshot?.max ?? null} knownStatus={knownStatus} events={activity.events} verifySession={verifySession} operator={operator} onLocate={onLocate} />
}

type MapTarget = { event: WorldLocation } | { player: PlayerMapTarget }

function LiveDashboard({ account, refresh, signOut, signingOut, signOutError }: {
  account: Account
  refresh: () => Promise<void>
  signOut: () => Promise<void>
  signingOut: boolean
  signOutError: string
}) {
  const canManage = account.role === 'operator'
  const commands = useGameCommands(canManage, account.csrf, refresh)
  const [view, setView] = useState(() => getView(canManage))
  const [mapTarget, setMapTarget] = useState<MapTarget | null>(null)
  const main = useRef<HTMLElement>(null)
  const stats = useFeed('/api/mcc/stats', loadingStats, refresh, 30_000)
  const snapshot = stats.snapshot
  const historyTime = stats.health === 'error' ? stats.checkedAt ?? snapshot?.time : snapshot?.time
  useEffect(() => {
    function navigate() {
      const nextView = getView(canManage)
      setView(nextView)
      if (nextView !== 'world') setMapTarget(null)
      main.current?.focus({ preventScroll: true })
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [canManage])

  const links = (Object.keys(nav) as LiveView[]).filter((key) => (key !== 'backups' && key !== 'files') || canManage).map((key) => {
    const { title, icon: Icon } = nav[key]
    return <a key={key} href={'#observatory/' + key} aria-current={view === key ? 'page' : undefined}><Icon size={18} aria-hidden="true" /><span>{title}</span></a>
  })
  const hasCurrent = snapshot !== null && stats.health === 'ok'
  const running = hasCurrent && snapshot.running
  const craftyTerminal = canManage ? stats.craftyTerminal : undefined
  function showOnMap(target: MapTarget) {
    setMapTarget(target)
    window.location.hash = '#observatory/world'
  }
  const showEventOnMap = canManage ? (event: WorldLocation) => showOnMap({ event }) : undefined
  const showPlayerOnMap = canManage ? (player: PlayerMapTarget) => showOnMap({ player }) : undefined

  return <div className="app observatory live-app">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); main.current?.focus() }}>Przejdź do treści</a>
    <aside className="sidebar">
      <a className="brand-link" href="#observatory/overview" aria-label="MCC — przegląd"><Brand /></a>
      <nav className="navigation" aria-label="Główna nawigacja">{links}</nav>
    </aside>
    <div className="shell">
      <header className="topbar">
        <div className="breadcrumb"><span>MCC</span><ChevronRight size={14} /><strong>{nav[view].title}</strong></div>
        <div className="topbar-tools session-tools">
          <span className="demo-badge live-badge"><span /> Dane z Crafty</span>
          <span className="session-role" title={account.username}>{account.role === 'operator' ? 'Operator' : 'Podgląd'}</span>
          <a className="design-link" href="?mode=demo#observatory/overview">Tryb demo</a>
          <Button loading={signingOut} onClick={() => void signOut()}>{signingOut ? 'Wylogowywanie…' : 'Wyloguj'}</Button>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="content" ref={main}>
        {signOutError && <div role="alert"><Notice title={signOutError} tone="error" /></div>}
        {view === 'overview' ? <>
          <section className="hero" aria-label={stats.name}>
            <div className="hero-content">
              <div className="hero-meta">
                {hasCurrent && (!snapshot.running || snapshot.reachable) ? <ServerStatus online={snapshot.running} />
                  : <span className="demo-badge">{running ? 'Proces działa · Gra nie odpowiada' : 'Status nieznany'}</span>}
                <span>JAVA EDITION{snapshot?.version ? ' · ' + snapshot.version : ''}</span>
              </div>
              <h1>{stats.name}</h1>
              <p><Clock3 size={15} aria-hidden="true" />{stats.updatedAt ? 'Ostatni odczyt ' + formatTime(stats.updatedAt, true) : 'Oczekiwanie na odczyt'}</p>
              <div className="hero-actions">
                <a className="button primary" href="#observatory/console"><Terminal size={16} aria-hidden="true" /> Konsola MCC</a>
                {craftyTerminal && <CraftyTerminalLink href={craftyTerminal} />}
              </div>
            </div>
          </section>
          <ConnectionNotice state={stats} resource="statystyk" gameStatus />
          {hasCurrent && snapshot.running && !snapshot.reachable && <Notice title="Proces działa, ping gry niedostępny">Liczba graczy i wersja pojawią się po odpowiedzi Minecrafta.</Notice>}
          <LiveMetrics state={stats} />
          <MetricHistory sampleMinute={historyTime === undefined ? null : Math.floor(historyTime / 60_000)} verifySession={refresh} />
          <LiveActivity verifySession={refresh} compact onLocate={showEventOnMap} />
          {account.role === 'operator' && <PowerPanel csrf={account.csrf} running={hasCurrent ? snapshot.running : null} />}
          <PushSettings account={account} verifySession={refresh} />
        </> : <div className="view-header"><p>{stats.name}</p><h1>{nav[view].title}</h1></div>}
        {view === 'console' && <>
          {craftyTerminal && <div><CraftyTerminalLink href={craftyTerminal} /></div>}
          <LiveConsole verifySession={refresh} commands={commands} operator={canManage} running={running} />
        </>}
        {view === 'players' && <><ConnectionNotice state={stats} resource="listy graczy" />
          <LivePlayers snapshot={snapshot} knownStatus={hasCurrent} verifySession={refresh} operator={canManage} onLocate={showPlayerOnMap} />
          {canManage && <PlayerControls commands={commands} running={running} />}</>}
        {view === 'world' && <>
          <Suspense fallback={<p className="empty-state" role="status">Wczytywanie mapy…</p>}>
            <WorldMap account={account} verifySession={refresh} commands={commands} running={running && snapshot.reachable}
              initialLocation={canManage && mapTarget && 'event' in mapTarget ? mapTarget.event : null}
              initialPlayer={canManage && mapTarget && 'player' in mapTarget ? mapTarget.player : null} />
          </Suspense>
          {canManage && <WorldControls commands={commands} running={running} />}
        </>}
        {view === 'activity' && <LiveActivity verifySession={refresh} onLocate={showEventOnMap} />}
        {view === 'files' && canManage && <Suspense fallback={<p className="empty-state" role="status">Wczytywanie plików…</p>}>
          <FileView account={account} running={hasCurrent ? snapshot.running : null} verifySession={refresh} />
        </Suspense>}
        {view === 'backups' && canManage && <>
          <CraftyBackups account={account} running={hasCurrent ? snapshot.running : null} verifySession={refresh} />
          <BackupView verifySession={refresh} />
        </>}
      </main>
    </div>
    <nav className="mobile-nav" aria-label="Nawigacja mobilna">{links}</nav>
    {canManage && <CommandConfirmation commands={commands} />}
  </div>
}

export default function LiveApp() {
  return <SessionGate>{(account, actions) => <LiveDashboard account={account} {...actions} />}</SessionGate>
}
