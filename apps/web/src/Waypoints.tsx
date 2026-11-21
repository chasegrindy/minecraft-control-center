import { useState } from 'react'
import type { FormEvent } from 'react'
import { Flag, MapPin, Plus, Sprout } from 'lucide-react'
import type { Account } from './SessionGate'
import { Button, Notice, PanelHeading } from './ui'

export const waypointKinds = {
  point: { label: 'Punkt', color: '#a0e3ad', Icon: MapPin },
  base: { label: 'Baza', color: '#e4bf8a', Icon: Flag },
  farm: { label: 'Farma', color: '#a8a1db', Icon: Sprout },
} as const

export type Coordinate = [number, number]
export type Waypoint = {
  id: string
  dimension: 'overworld' | 'nether' | 'end'
  category: keyof typeof waypointKinds
  name: string
  x: number
  z: number
  hologramY?: number
}

type WaypointProps = {
  account: Account
  points: Waypoint[] | null
  loadFailed: boolean
  dimension: Waypoint['dimension']
  bounds: [number, number, number, number]
  picked: Coordinate | null
  onFocus: (coordinate: Coordinate) => void
  onChange: (next: Waypoint[]) => void
  verifySession: () => Promise<void>
}

function HologramFields({ dimension, initial }: { dimension: Waypoint['dimension']; initial?: number }) {
  const [enabled, setEnabled] = useState(initial !== undefined)
  const [height, setHeight] = useState(initial === undefined ? '' : String(initial))
  return <>
    <label className="waypoint-hologram"><input type="checkbox" name="showInGame" checked={enabled}
      onChange={(event) => setEnabled(event.target.checked)} /> Pokaż w grze</label>
    {enabled && <label>Wysokość Y<input name="hologramY" type="number" step={1}
      min={dimension === 'overworld' ? -64 : 0} max={dimension === 'overworld' ? 319 : 255} required
      value={height} onChange={(event) => setHeight(event.target.value)} /></label>}
  </>
}

function readHologram(fields: FormData) {
  return fields.has('showInGame') ? Number(fields.get('hologramY')) : null
}

export function Waypoints({ account, points, loadFailed, dimension, bounds, picked, onFocus, onChange, verifySession }: WaypointProps) {
  const [adding, setAdding] = useState(false)
  const [x, setX] = useState('')
  const [z, setZ] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(null)
  const canEdit = account.role === 'operator'
  const visible = points?.filter((point) => point.dimension === dimension) ?? []

  function usePicked() {
    setX(picked ? String(picked[0]) : '')
    setZ(picked ? String(picked[1]) : '')
  }

  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', data: { id: string; hologramY?: number | null }, success: string) {
    if (pending) return
    setPending(true)
    setStatus('')
    setError('')
    try {
      const response = await fetch('/api/mcc/waypoints', {
        method,
        headers: { 'Content-Type': 'application/json', 'X-MCC-CSRF': account.csrf },
        body: JSON.stringify(data),
      })
      if (response.status === 401) await verifySession()
      if (response.status === 409) {
        setError('Punktu nie udało się zapisać. Sprawdź, czy lista zawiera mniej niż 100 punktów.')
        return
      }
      if (response.status === 400) {
        setError('Sprawdź nazwę, typ i współrzędne punktu.')
        return
      }
      if (response.status === 404) {
        onChange((await response.json()).points)
        setEditing(null)
        setError('Ten punkt został już usunięty.')
        return
      }
      if (!response.ok) throw new Error('Waypoint update failed')
      const next: { points: Waypoint[] } = await response.json()
      onChange(next.points)
      setStatus(success)
      setAdding(false)
      setConfirming(null)
      setEditing(null)
      setAttempt(null)
    } catch {
      setError('Nie udało się zatwierdzić zmiany. Spróbuj ponownie.')
    } finally {
      setPending(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const hologramY = readHologram(fields)
    const location = { name: String(fields.get('name')).trim(), category: String(fields.get('category')), dimension,
      x: Number(x), z: Number(z), ...(hologramY === null ? {} : { hologramY }) }
    if (!location.name || x.trim() === '' || z.trim() === '') {
      setError('Wpisz nazwę i współrzędne punktu.')
      return
    }
    const key = JSON.stringify(location)
    const id = attempt?.key === key ? attempt.id : crypto.randomUUID()
    setAttempt({ key, id })
    void mutate('POST', { ...location, id }, 'Punkt został zapisany.')
  }

  return <section className="panel waypoint-panel" aria-label="Zapisane punkty">
    <PanelHeading title="Zapisane punkty">
      {canEdit && points && !adding && <Button onClick={() => { usePicked(); setAdding(true); setEditing(null); setConfirming(null); setError(''); setStatus('') }}>
        <Plus size={16} aria-hidden="true" /> Dodaj punkt
      </Button>}
    </PanelHeading>
    {loadFailed && <div role="alert"><Notice title="Zapisane punkty są chwilowo niedostępne" tone="error" /></div>}
    {!loadFailed && !points && <p className="empty-state" role="status">Wczytywanie punktów…</p>}
    {adding && <form className="waypoint-form" onSubmit={submit}>
      <fieldset disabled={pending}>
        <legend>Nowy punkt</legend>
        <label>Nazwa<input name="name" required maxLength={60} autoComplete="off" /></label>
        <label>Typ
          <select name="category">
            {Object.entries(waypointKinds).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>X<input type="number" step={1} min={-30_000_000} max={30_000_000} required value={x} onChange={(event) => setX(event.target.value)} /></label>
        <label>Z<input type="number" step={1} min={-30_000_000} max={30_000_000} required value={z} onChange={(event) => setZ(event.target.value)} /></label>
        <HologramFields dimension={dimension} />
      </fieldset>
      <div className="world-map-actions">
        <Button variant="primary" type="submit" loading={pending}>Zapisz punkt</Button>
        {picked && <Button onClick={usePicked} disabled={pending}>Użyj punktu z mapy</Button>}
        <Button onClick={() => { setAdding(false); setError('') }} disabled={pending}>Anuluj</Button>
      </div>
    </form>}
    {status && <p className="waypoint-message" role="status">{status}</p>}
    {error && <div role="alert"><Notice title={error} tone="error" /></div>}
    {points && !visible.length && !adding && <p className="empty-state">Brak zapisanych punktów w tym wymiarze.</p>}
    {visible.length > 0 && <ul className="waypoint-list">
      {visible.map((point) => {
        const { Icon, label } = waypointKinds[point.category]
        const inBounds = point.x >= bounds[0] && point.x < bounds[2] && point.z >= bounds[1] && point.z < bounds[3]
        return <li key={point.id}>
          <span className="event-icon"><Icon size={17} aria-hidden="true" /></span>
          <div><strong>{point.name}</strong><p>{label} · X {point.x} · Z {point.z}{point.hologramY === undefined ? '' : ' · Hologram Y ' + point.hologramY}{inBounds ? '' : ' · poza obszarem kopii'}</p></div>
          {editing === point.id ? <form className="waypoint-form waypoint-hologram-editor" onSubmit={(event) => {
            event.preventDefault()
            void mutate('PATCH', { id: point.id, hologramY: readHologram(new FormData(event.currentTarget)) }, 'Zapisano ustawienia hologramu.')
          }}>
            <fieldset disabled={pending}>
              <legend>Hologram · {point.name}</legend>
              <HologramFields dimension={point.dimension} initial={point.hologramY} />
            </fieldset>
            <div className="world-map-actions">
              <Button type="submit" loading={pending}>Zapisz hologram</Button>
              <Button disabled={pending} onClick={() => setEditing(null)}>Anuluj</Button>
            </div>
          </form> : confirming === point.id
            ? <div className="world-map-actions waypoint-confirm">
              <span>Usunąć ten punkt?</span>
              <Button variant="danger" loading={pending} onClick={() => void mutate('DELETE', { id: point.id }, 'Punkt został usunięty.')}>Usuń punkt</Button>
              <Button disabled={pending} onClick={() => setConfirming(null)}>Anuluj</Button>
            </div>
            : <div className="world-map-actions">
              {inBounds && <Button onClick={() => onFocus([point.x, point.z])} aria-label={'Pokaż na mapie: ' + point.name}>Pokaż na mapie</Button>}
              {canEdit && <Button disabled={pending || adding} onClick={() => { setEditing(point.id); setConfirming(null); setError(''); setStatus('') }}
                aria-label={'Ustaw hologram: ' + point.name}>Hologram</Button>}
              {canEdit && <Button disabled={pending || adding} onClick={() => { setConfirming(point.id); setError(''); setStatus('') }} aria-label={'Usuń punkt: ' + point.name}>Usuń</Button>}
            </div>}
        </li>
      })}
    </ul>}
  </section>
}
