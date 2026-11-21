import { useId, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowRight, Box, Clock3, Cpu, Gauge, HardDrive, LogIn, LogOut,
  MapPin, MemoryStick, Minus, Navigation, Pause, Play, Plus, RotateCw, Skull, Square, Terminal, Trophy, Users,
} from 'lucide-react'
import { actions, demoOnlinePlayers, dimensions, formatTime, markers, playerLimit } from './demo'
import { memoryLimit } from './demo-state'
import type { Sample } from './demo-state'
import type { Dimension, ServerAction, View, WorldEvent } from './demo'
import { Button, IconButton, PanelHeading, SegmentedControl, ServerStatus } from './ui'

export type Navigate = (view: View) => void
type RequestAction = (action: ServerAction) => void

export function Hero({ online, pending, navigate, requestAction }: { online: boolean; pending: ServerAction | null; navigate: Navigate; requestAction: RequestAction }) {
  const action = online ? 'restart' : 'start'
  return (
    <section className="hero" aria-label="Serwer Northstar Survival">
      <div className="hero-content">
        <div className="hero-meta"><ServerStatus online={online} /><span>JAVA EDITION · 1.21.11</span></div>
        <h1>Northstar Survival</h1>
        <p><Box size={15} /> Świat survival <span>·</span> <Clock3 size={15} /> Europe/Warsaw</p>
        <div className="hero-actions">
          <Button variant="primary" onClick={() => navigate('console')}><Terminal size={16} /> Otwórz konsolę</Button>
          <Button variant="ghost" loading={pending === action} disabled={pending !== null && pending !== action} onClick={() => requestAction(action)}>
            {!pending && (online ? <RotateCw size={15} /> : <Play size={15} />)} {pending === action ? 'W toku…' : actions[action].label}
          </Button>
        </div>
      </div>
    </section>
  )
}

const decimal = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })

function formatUptime(timestamp: number, startedAt: number | null) {
  if (startedAt === null) return '—'
  const minutes = Math.max(0, Math.floor((timestamp - startedAt) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes / 60) % 24
  const prefix = (value: number) => String(value).padStart(2, '0')
  return days ? prefix(days) + 'd ' + prefix(hours) + 'h' : prefix(hours) + 'h ' + prefix(minutes % 60) + 'm'
}

export function MetricCards({ sample, startedAt }: { sample: Sample; startedAt: number | null }) {
  const count = startedAt === null ? 0 : demoOnlinePlayers.length
  const data = [
    { name: 'Gracze online', icon: Users, value: count, suffix: '/ ' + playerLimit, detail: 'Limit miejsc na serwerze', ratio: count / playerLimit * 100, color: 'green' },
    { name: 'Użycie CPU', icon: Cpu, value: sample.cpu, suffix: '%', detail: '2 OCPU · Ampere A1', ratio: sample.cpu, color: 'green' },
    { name: 'Pamięć RAM', icon: MemoryStick, value: decimal.format(sample.ram * memoryLimit / 100), suffix: ' / ' + memoryLimit + ' GB', detail: 'Pamięć procesu w demo', ratio: sample.ram, color: 'violet' },
    { name: 'Wydajność ticków', icon: Gauge, value: sample.tps === null ? '—' : decimal.format(sample.tps), suffix: ' TPS', detail: sample.mspt === null ? 'Brak pomiaru podczas postoju' : decimal.format(sample.mspt) + ' ms / tick', ratio: (sample.tps ?? 0) * 5, color: 'gold' },
    { name: 'Czas działania', icon: Clock3, value: formatUptime(sample.at, startedAt), suffix: '', detail: startedAt === null ? 'Proces zatrzymany' : 'Od uruchomienia procesu', ratio: null, color: 'green' },
  ]
  return (
    <section className="metrics" aria-label="Statystyki serwera demo">
      {data.map(({ name, icon: Icon, value, suffix, detail, ratio, color }) => (
        <article className="metric" key={name}>
          <div className="metric-label"><Icon size={17} />{name}</div>
          <div className="metric-value">{value}<span>{suffix}</span></div>
          <div className="metric-bottom">{ratio !== null && <span className={'meter ' + color} aria-hidden="true"><span style={{ width: ratio + '%' }} /></span>}{detail}</div>
        </article>
      ))}
    </section>
  )
}

const windows = { '1 h': 1, '6 h': 6, '24 h': 24 } as const
type ChartRange = keyof typeof windows

export function Performance({ samples, sample, online, paused, togglePause }: {
  samples: Sample[]
  sample: Sample
  online: boolean
  paused: boolean
  togglePause: () => void
}) {
  const [range, setRange] = useState<ChartRange>('1 h')
  const [selected, setSelected] = useState({ cpu: true, ram: true })
  const id = useId()
  const duration = windows[range] * 3_600_000
  const start = sample.at - duration
  const visible = samples.filter((entry) => entry.at >= start)
  const x = (timestamp: number) => (timestamp - start) * 600 / duration
  const points = (key: 'cpu' | 'ram') => visible.map((entry) => [x(entry.at).toFixed(1), 100 - entry[key]].join(',')).join(' ')
  const chartLabel = 'Historia demo z ostatnich ' + range + '. ' + (selected.cpu ? 'CPU ' + sample.cpu + ' procent. ' : '') + (selected.ram ? 'RAM ' + sample.ram + ' procent.' : '')
  const timestamps = Array.from({ length: 5 }, (_, index) => start + index * duration / 4)

  return (
    <section className="panel performance" aria-labelledby="performance-title">
      <PanelHeading id="performance-title" title="Obciążenie serwera" description="Historia wykorzystania zasobów · demo">
        <SegmentedControl label="Zakres wykresu" options={Object.keys(windows) as ChartRange[]} value={range} onChange={setRange} />
      </PanelHeading>
      <div className="telemetry-tools">
        <p><time dateTime={new Date(sample.at).toISOString()}>{formatTime(sample.at, true)}</time> · {online ? (paused ? 'Wstrzymano odczyty' : 'Odczyty co 5 s') : 'Serwer offline'}</p>
        <Button disabled={!online} onClick={togglePause}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? 'Wznów odczyty' : 'Wstrzymaj odczyty'}</Button>
      </div>
      <div className="chart-legend" role="group" aria-label="Serie wykresu">
        {(['cpu', 'ram'] as const).map((key) => (
          <button key={key} className={'legend-key ' + key} aria-pressed={selected[key]} onClick={() => {
            if (selected[key] && !selected[key === 'cpu' ? 'ram' : 'cpu']) return
            setSelected({ ...selected, [key]: !selected[key] })
          }}><span />{key.toUpperCase()}</button>
        ))}
      </div>
      <div className="plot">
        <div className="y-axis" aria-hidden="true">{[100, 75, 50, 25, 0].map((value) => <span key={value}>{value}%</span>)}</div>
        <div className="plot-area">
          <div className="plot-grid" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label={chartLabel}>
            <defs><linearGradient id={id} x2="0" y2="1"><stop offset="0%" className="fill-top" /><stop offset="100%" className="fill-bottom" /></linearGradient></defs>
            {selected.cpu && <polygon points={x(visible[0].at).toFixed(1) + ',100 ' + points('cpu') + ' 600,100'} fill={'url(#' + id + ')'} />}
            {selected.ram && <polyline points={points('ram')} className="ram-line" vectorEffect="non-scaling-stroke" />}
            {selected.cpu && <polyline points={points('cpu')} className="cpu-line" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
        <div className="x-axis" aria-hidden="true">{timestamps.map((time) => <span key={time}>{formatTime(time)}</span>)}</div>
      </div>
    </section>
  )
}

const eventIcons = { join: LogIn, leave: LogOut, presence: Users, backup: HardDrive, advancement: Trophy, death: Skull, action: Activity, boss: Trophy, dimension: Navigation }

type EventRow = Omit<WorldEvent, 'kind'> & {
  kind: WorldEvent['kind'] | 'presence'
  dateTime?: string
  showOnMap?: () => void
  visits?: { id: string; label: string; time: string; dateTime: string }[]
}

export function EventList({ events }: { events: EventRow[] }) {
  return <ul className="events">
    {events.map((event) => {
      const Icon = eventIcons[event.kind]
      return <li key={event.id}>
        <span className={'event-icon ' + event.kind}><Icon size={16} aria-hidden="true" /></span>
        <div>
          <strong>{event.title}</strong><span>{event.detail}</span>
          {event.visits && <details className="event-visits">
            <summary>Godziny wejść i wyjść</summary>
            <ul aria-label="Godziny aktywności">
              {event.visits.map((visit) => <li key={visit.id}>
                <time dateTime={visit.dateTime}>{visit.time}</time>{visit.label}
              </li>)}
            </ul>
          </details>}
          {event.showOnMap && <Button className="event-map-action" variant="ghost"
            aria-label={'Pokaż na mapie · ' + event.title} onClick={event.showOnMap}>
            <MapPin size={15} aria-hidden="true" /> Pokaż na mapie
          </Button>}
        </div>
        <time dateTime={event.dateTime}>{event.time}</time>
      </li>
    })}
  </ul>
}

export function ActivityPanel({ events, navigate }: { events: WorldEvent[]; navigate?: Navigate }) {
  return (
    <section className="panel activity-panel" aria-label="Ostatnia aktywność">
      <PanelHeading title="Ostatnia aktywność" description="Zdarzenia na serwerze demo">
        {navigate && <IconButton aria-label="Otwórz pełną aktywność" title="Otwórz pełną aktywność" onClick={() => navigate('activity')}><ArrowRight size={18} /></IconButton>}
      </PanelHeading>
      <EventList events={navigate ? events.slice(0, 4) : events} />
    </section>
  )
}

const actionIcons = { start: Play, stop: Square, restart: RotateCw }

export function QuickActions({ online, pending, requestAction, navigate }: { online: boolean; pending: ServerAction | null; requestAction: RequestAction; navigate: Navigate }) {
  const availableActions: ServerAction[] = online ? ['restart', 'stop'] : ['start']
  return (
    <section className="panel quick-actions">
      <PanelHeading title="Sterowanie serwerem" description="Operacje w symulacji"><ServerStatus online={online} /></PanelHeading>
      <div className="action-list">
        {availableActions.map((action) => {
          const Icon = actionIcons[action]
          return <Button key={action} variant={action === 'stop' ? 'danger' : 'secondary'} loading={pending === action} disabled={pending !== null && pending !== action} onClick={() => requestAction(action)}>
            {pending === action ? 'Operacja w toku…' : <><Icon size={16} />{actions[action].label} serwer</>}
          </Button>
        })}
        <Button onClick={() => navigate('console')}><Terminal size={17} /> Konsola</Button>
      </div>
    </section>
  )
}

export function WorldMap({ online }: { online: boolean }) {
  const [dimension, setDimension] = useState<Dimension>('overworld')
  const [zoom, setZoom] = useState(1)
  const [markerIndex, setMarkerIndex] = useState<number | null>(null)
  const selectedMarker = markerIndex === null ? null : markers[dimension][markerIndex]
  const marker = selectedMarker?.type === 'player' && !online ? null : selectedMarker
  return (
    <section className="panel map-panel" aria-label="Mapa ilustracyjna świata demo">
      <PanelHeading title="Mapa świata" description="Ilustracja i przykładowe znaczniki">
        <select aria-label="Wymiar świata" value={dimension} onChange={(e) => { setDimension(e.target.value as Dimension); setMarkerIndex(null); setZoom(1) }}>
          {(Object.keys(dimensions) as Dimension[]).map((option) => <option key={option} value={option}>{dimensions[option]}</option>)}
        </select>
      </PanelHeading>
      <div className={'map-frame ' + dimension}>
        <div className="map-layer" style={{ transform: 'scale(' + zoom + ')' }}>
          {markers[dimension].map((point, index) => (online || point.type !== 'player') && (
            <button key={point.name} className={'map-pin ' + point.type} style={{ left: point.x + '%', top: point.y + '%' }} aria-pressed={markerIndex === index} aria-label={point.name} onClick={() => setMarkerIndex(markerIndex === index ? null : index)}>
              {point.type === 'player' ? <Users size={14} /> : <MapPin size={15} />}
            </button>
          ))}
        </div>
        <span className="compass"><Navigation size={15} /> N</span>
        <div className="map-controls" role="group" aria-label="Powiększenie mapy">
          <IconButton aria-label="Powiększ mapę" disabled={zoom >= 1.5} onClick={() => setZoom(zoom + 0.25)}><Plus size={17} /></IconButton>
          <IconButton aria-label="Pomniejsz mapę" disabled={zoom <= 1} onClick={() => setZoom(zoom - 0.25)}><Minus size={17} /></IconButton>
        </div>
      </div>
      <div className="map-footer" aria-live="polite">
        {marker ? <><strong>{marker.name}</strong><span>{marker.position}</span></> : <><span><MapPin size={15} /> Punkty świata</span><span><Users size={15} /> {online ? 'Pozycje graczy' : 'Brak graczy online'}</span></>}
      </div>
    </section>
  )
}

export function BackupNote({ time }: { time: string | undefined }) {
  return time && <div className="operator-backup"><ArrowDownToLine size={16} /><span>Ostatnia kopia · {time}</span></div>
}
