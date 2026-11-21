import { useEffect, useMemo, useRef, useState } from 'react'
import { LocateFixed, Minus, Plus } from 'lucide-react'
import Feature from 'ol/Feature.js'
import OpenLayersMap from 'ol/Map.js'
import View from 'ol/View.js'
import Point from 'ol/geom/Point.js'
import TileLayer from 'ol/layer/Tile.js'
import VectorLayer from 'ol/layer/Vector.js'
import Projection from 'ol/proj/Projection.js'
import ImageTile from 'ol/source/ImageTile.js'
import VectorSource from 'ol/source/Vector.js'
import CircleStyle from 'ol/style/Circle.js'
import Fill from 'ol/style/Fill.js'
import Stroke from 'ol/style/Stroke.js'
import Style from 'ol/style/Style.js'
import Text from 'ol/style/Text.js'
import TileGrid from 'ol/tilegrid/TileGrid.js'
import 'ol/ol.css'
import { Button, Notice } from './ui'
import type { WorldLocation } from './demo'
import type { Account } from './SessionGate'
import { CommandStatus, MapTeleport } from './GameCommands'
import type { Commands } from './GameCommands'
import { Waypoints, waypointKinds } from './Waypoints'
import type { Coordinate, Waypoint } from './Waypoints'
import { useFeed } from './live-feed'
import type { Connection } from './live-feed'
import { positionDimensions as names, usePlayerPositions } from './player-positions'
import type { PlayerMapTarget, PlayerPosition } from './player-positions'

type Dimension = {
  id: keyof typeof names
  bounds: [number, number, number, number]
  minZoom: number
  maxZoom: number
}
type Snapshot = { date: string | null; dimensions: Dimension[]; livePositions?: boolean; liveDeaths?: boolean }
type DeathPosition = PlayerPosition & { time?: number }
type DeathFeed = Connection & { positions: (DeathPosition & { time: number })[]; status: 'waiting' | 'ok' | 'error' }
type DeathSnapshot = { capturedAt: number; lastDeaths: { positions: DeathPosition[]; skipped: number } }
const loadingDeaths: DeathFeed = { health: 'loading', updatedAt: null, positions: [], status: 'waiting' }
const emptyPositions: PlayerPosition[] = []
const worldExtent = [-30_000_000, -30_000_000, 30_000_000, 30_000_000]

const pinStyles = Object.fromEntries(Object.entries(waypointKinds).map(([kind, { color }]) => [kind,
  new Style({ image: new CircleStyle({ radius: 6, fill: new Fill({ color }), stroke: new Stroke({ color: '#0d110f', width: 2 }) }) }),
]))
const pickedStyle = new Style({ image: new CircleStyle({ radius: 10, stroke: new Stroke({ color: '#ffffff', width: 2 }) }) })
const playerPin = new CircleStyle({ radius: 7, fill: new Fill({ color: '#a8e7ee' }), stroke: new Stroke({ color: '#0d110f', width: 2 }) })
const playerLabel = new Fill({ color: '#e9fcff' })
const playerOutline = new Stroke({ color: '#0d110f', width: 3 })
const deathPin = new CircleStyle({ radius: 7, fill: new Fill({ color: '#ffb29c' }), stroke: new Stroke({ color: '#0d110f', width: 2 }) })
const deathLabel = new Fill({ color: '#ffe2d8' })

function Terrain({ dimension, points, picked, focus, players, deaths, showOutside, onPick }: {
  dimension: Dimension
  points: Waypoint[] | null
  picked: Coordinate | null
  focus: Coordinate | null
  players: PlayerPosition[]
  deaths: PlayerPosition[]
  showOutside: boolean
  onPick: (coordinate: Coordinate) => void
}) {
  const target = useRef<HTMLDivElement>(null)
  const pins = useRef<VectorSource<Feature<Point>> | null>(null)
  const playerPins = useRef<VectorSource<Feature<Point>> | null>(null)
  const controls = useRef<{ fit: () => void; zoom: (offset: number) => void; locate: (coordinate: Coordinate) => void } | null>(null)
  const [position, setPosition] = useState<Coordinate>()
  const [tileFailed, setTileFailed] = useState(false)

  useEffect(() => {
    const element = target.current
    if (!element) return
    const [west, north, east, south] = dimension.bounds
    const extent = [west, -south, east, -north]
    const projection = new Projection({ code: 'MCC:' + dimension.id, units: 'pixels', extent })
    const resolutions = Array.from({ length: dimension.maxZoom - dimension.minZoom + 1 },
      (_, index) => 2 ** -(dimension.minZoom + index))
    const tileGrid = new TileGrid({ extent, origin: [0, 0], resolutions, tileSize: 256 })
    const blank = document.createElement('canvas')
    blank.width = 256
    blank.height = 256
    const source = new ImageTile({
      projection,
      tileGrid,
      wrapX: false,
      interpolate: false,
      transition: 0,
      loader: async (zoom, x, z, { signal }) => {
        const response = await fetch('/api/mcc/map/' + dimension.id + '/' + (dimension.minZoom + zoom) + '/' + x + '/' + z, { signal })
        if (response.status === 204) return blank
        if (!response.ok) throw new Error('Błąd pobierania terenu')
        return createImageBitmap(await response.blob())
      },
    })
    source.on('tileloaderror', () => setTileFailed(true))
    const view = new View({ projection, extent: showOutside ? worldExtent : extent, resolutions, showFullExtent: true, enableRotation: false })
    const markers = new VectorSource<Feature<Point>>({ wrapX: false })
    const players = new VectorSource<Feature<Point>>({ wrapX: false })
    pins.current = markers
    playerPins.current = players
    const map = new OpenLayersMap({ target: element, layers: [new TileLayer({ source }), new VectorLayer({ source: markers }),
      new VectorLayer({ source: players, declutter: true })], view, controls: [] })
    function fit() {
      view.fit(extent, { padding: [16, 16, 16, 16] })
    }
    controls.current = {
      fit,
      zoom: (offset) => view.adjustZoom(offset),
      locate([x, z]) {
        view.setResolution(Math.min(view.getResolution() ?? 4, 4))
        view.setCenter([x, -z])
        element.scrollIntoView({ block: 'nearest' })
      },
    }
    map.on('singleclick', ({ coordinate }) => onPick([Math.floor(coordinate[0]), Math.floor(-coordinate[1])]))
    map.on('moveend', () => {
      const center = view.getCenter()
      if (center) setPosition([Math.floor(center[0]), Math.floor(-center[1])])
    })
    fit()
    return () => {
      controls.current = null
      pins.current = null
      playerPins.current = null
      map.dispose()
    }
  }, [dimension, onPick, showOutside])

  useEffect(() => {
    const markers = pins.current
    if (!markers) return
    markers.clear()
    for (const point of points ?? []) {
      if (point.dimension !== dimension.id) continue
      const feature = new Feature(new Point([point.x, -point.z]))
      feature.setStyle(pinStyles[point.category])
      markers.addFeature(feature)
    }
    for (const death of deaths) {
      if (death.dimension !== dimension.id) continue
      const feature = new Feature(new Point([death.x, -death.z]))
      feature.setStyle(new Style({ image: deathPin, text: new Text({ text: '† ' + death.name, offsetY: -16,
        font: '600 12px system-ui', fill: deathLabel, stroke: playerOutline }) }))
      markers.addFeature(feature)
    }
    if (picked) {
      const feature = new Feature(new Point([picked[0], -picked[1]]))
      feature.setStyle(pickedStyle)
      markers.addFeature(feature)
    }
  }, [dimension, points, deaths, picked, showOutside])

  useEffect(() => {
    const layer = playerPins.current
    if (!layer) return
    layer.clear(true)
    for (const player of players) {
      if (player.dimension !== dimension.id) continue
      const feature = new Feature(new Point([player.x, -player.z]))
      feature.setStyle(new Style({ image: playerPin, text: new Text({ text: player.name, offsetY: -16,
        font: '600 12px system-ui', fill: playerLabel, stroke: playerOutline }) }))
      layer.addFeature(feature)
    }
  }, [dimension, players, showOutside])

  useEffect(() => {
    if (focus) controls.current?.locate(focus)
  }, [focus, showOutside])

  const displayed = picked ?? position
  return <>
    <div className="world-map" ref={target} tabIndex={0} role="region" aria-label={'Interaktywna mapa ' + names[dimension.id]} />
    <div className="world-map-footer">
      <div className="world-map-actions">
        <Button aria-label="Powiększ mapę" onClick={() => controls.current?.zoom(1)}><Plus size={17} aria-hidden="true" /></Button>
        <Button aria-label="Pomniejsz mapę" onClick={() => controls.current?.zoom(-1)}><Minus size={17} aria-hidden="true" /></Button>
        <Button onClick={() => controls.current?.fit()}><LocateFixed size={16} aria-hidden="true" /> Cały obszar</Button>
      </div>
      {displayed && <span>{picked ? 'Wskazany punkt' : 'Środek mapy'} <strong>X {displayed[0]} · Z {displayed[1]}</strong></span>}
    </div>
    {tileFailed && <p className="empty-state" role="status">Część terenu jest niedostępna. Odśwież widok, aby ponowić odczyt.</p>}
  </>
}

const dateFormat = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'long', timeZone: 'UTC' })
const dateTimeFormat = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' })

function covers(area: Dimension, { x, z }: WorldLocation) {
  const [west, north, east, south] = area.bounds
  return x >= west && x < east && z >= north && z < south
}

function latestDeathLocations(snapshot: DeathSnapshot | null, journal: DeathFeed['positions']) {
  const merged = new Map((snapshot?.lastDeaths.positions ?? []).map((position) => [position.uuid, position]))
  for (const death of journal) {
    if (!merged.has(death.uuid) || !snapshot || death.time > snapshot.capturedAt) merged.set(death.uuid, death)
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'pl'))
}

function PlayerLocations({ locations, dimensions, actionLabel, onLocate }: {
  locations: DeathPosition[]
  dimensions: Dimension[]
  actionLabel: string
  onLocate: (position: PlayerPosition) => void
}) {
  if (!locations.length) return null
  return <ul className="file-list">{locations.map((player) => {
    const area = dimensions.find(({ id }) => id === player.dimension)
    const outside = area && !covers(area, player)
    return <li key={player.uuid}>
      <strong>{player.name}</strong>
      <span>{names[player.dimension]} · X {player.x} · Y {player.y} · Z {player.z}{outside ? ' · Poza terenem kopii' : ''}
        {player.time !== undefined && <> · Dziennik Fabric <time dateTime={new Date(player.time).toISOString()}>{dateTimeFormat.format(player.time)}</time></>}
      </span>
      {area && <Button aria-label={actionLabel + ' ' + player.name} onClick={() => onLocate(player)}>Pokaż na mapie</Button>}
    </li>
  })}</ul>
}

export default function WorldMap({ account, verifySession, commands, running, initialLocation = null, initialPlayer = null }: {
  account: Account; verifySession: () => Promise<void>; initialLocation?: WorldLocation | null; initialPlayer?: PlayerMapTarget | null
  commands: Commands; running: boolean
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [selected, setSelected] = useState<Dimension['id']>(initialLocation?.dimension ?? 'overworld')
  const [failed, setFailed] = useState(false)
  const [waypoints, setWaypoints] = useState<Waypoint[] | null>(null)
  const [pointsFailed, setPointsFailed] = useState(false)
  const [picked, setPicked] = useState<Coordinate | null>(null)
  const [focus, setFocus] = useState<Coordinate | null>(null)
  const [deaths, setDeaths] = useState<DeathSnapshot | null>(null)
  const [deathRead, setDeathRead] = useState<'loading' | 'ok' | 'error'>('loading')
  const locatedPlayer = useRef<PlayerMapTarget | null>(null)
  const isOperator = account.role === 'operator'
  const showPlayers = isOperator && snapshot?.livePositions === true && snapshot.dimensions.length > 0
  const showLiveDeaths = isOperator && snapshot?.liveDeaths === true && snapshot.dimensions.length > 0
  const positions = usePlayerPositions(showPlayers, verifySession)
  const journal = useFeed(showLiveDeaths ? '/api/mcc/map-deaths' : null, loadingDeaths, verifySession, 15_000)
  const livePlayers = positions.health === 'ok' ? positions.positions : emptyPositions
  const hasNewPositionSample = Boolean(initialPlayer && positions.health === 'ok' && positions.updatedAt !== null
    && positions.updatedAt > initialPlayer.seenAt)
  const searchedPlayer = hasNewPositionSample ? livePlayers.find(({ uuid }) => uuid === initialPlayer?.uuid) : undefined
  const playerArea = searchedPlayer && snapshot?.dimensions.find(({ id }) => id === searchedPlayer.dimension)
  const lastDeaths = useMemo(() => isOperator ? latestDeathLocations(deaths, journal.positions) : emptyPositions,
    [isOperator, deaths, journal.positions])
  useEffect(() => {
    if (!isOperator || !initialPlayer || locatedPlayer.current === initialPlayer || !searchedPlayer || !playerArea) return
    locatedPlayer.current = initialPlayer
    setSelected(searchedPlayer.dimension)
    setPicked(null)
    setFocus([searchedPlayer.x, searchedPlayer.z])
  }, [isOperator, initialPlayer, searchedPlayer, playerArea])
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/mcc/map', { signal: controller.signal })
        if (response.status === 401) await verifySession()
        if (!response.ok) throw new Error('Błąd pobierania mapy')
        const data = await response.json() as Snapshot
        if (controller.signal.aborted) return
        setSnapshot(data)
        if (isOperator && initialLocation && data.dimensions.some(({ id }) => id === initialLocation.dimension)) {
          const target: Coordinate = [initialLocation.x, initialLocation.z]
          setPicked(target)
          setFocus(target)
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
    }
    void load()
    return () => controller.abort()
  }, [verifySession, isOperator, initialLocation])
  useEffect(() => {
    if (!isOperator) return
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/mcc/players', { signal: controller.signal })
        if (response.status === 401) await verifySession()
        if (!response.ok) throw new Error('Błąd odczytu zapisów graczy')
        const data: Partial<DeathSnapshot> = await response.json()
        if (data.lastDeaths && typeof data.capturedAt === 'number') {
          setDeaths({ capturedAt: data.capturedAt, lastDeaths: data.lastDeaths })
        }
        setDeathRead('ok')
      } catch {
        if (!controller.signal.aborted) setDeathRead('error')
      }
    }
    void load()
    return () => controller.abort()
  }, [isOperator, verifySession])
  function locate(player: PlayerPosition) {
    setSelected(player.dimension)
    setPicked(null)
    setFocus([player.x, player.z])
  }
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/mcc/waypoints', { signal: controller.signal })
        if (response.status === 401) await verifySession()
        if (!response.ok) throw new Error('Błąd odczytu punktów')
        const data: { points: Waypoint[] } = await response.json()
        setWaypoints(data.points)
      } catch {
        if (!controller.signal.aborted) setPointsFailed(true)
      }
    }
    void load()
    return () => controller.abort()
  }, [verifySession])
  if (failed) return <div role="alert"><Notice title="Mapa jest chwilowo niedostępna" tone="error" /></div>
  if (!snapshot) return <p className="empty-state" role="status">Wczytywanie mapy…</p>
  const dimension = snapshot.dimensions.find(({ id }) => id === selected) ?? snapshot.dimensions[0]
  if (!dimension || !snapshot.date) return <Notice title="Mapa jest w przygotowaniu" />
  const eventArea = isOperator && initialLocation ? snapshot.dimensions.find(({ id }) => id === initialLocation.dimension) : undefined
  const pickedEvent = eventArea && initialLocation && picked?.[0] === initialLocation.x && picked?.[1] === initialLocation.z
    && dimension.id === eventArea.id ? initialLocation : null
  return <>
    <section className="panel world-map-panel" aria-label="Mapa z kopii świata">
      <header className="world-map-header">
        <p>Kopia z <strong>{dateFormat.format(new Date(snapshot.date))}</strong></p>
        <label>Wymiar
          <select value={dimension.id} onChange={(event) => {
            setSelected(event.target.value as Dimension['id'])
            setPicked(null)
            setFocus(null)
          }}>
            {snapshot.dimensions.map(({ id }) => <option key={id} value={id}>{names[id]}</option>)}
          </select>
        </label>
      </header>
      {isOperator && initialLocation && !eventArea && <p className="empty-state" role="status">
        Mapa wymiaru {names[initialLocation.dimension]} jest niedostępna.
      </p>}
      {isOperator && initialPlayer && (!showPlayers || positions.health === 'error' || (hasNewPositionSample && !playerArea))
        && <p className="empty-state" role="status">Pozycja gracza {initialPlayer.name} jest niedostępna.</p>}
      <Terrain key={dimension.id} dimension={dimension} points={waypoints} picked={picked} focus={focus} onPick={setPicked}
        showOutside={showPlayers || showLiveDeaths || Boolean(eventArea) || lastDeaths.length > 0} players={livePlayers} deaths={lastDeaths} />
      {pickedEvent && <p className="empty-state" role="status">Miejsce zdarzenia · {names[pickedEvent.dimension]} · Y {pickedEvent.y}
        {!covers(dimension, pickedEvent) && ' · Poza terenem kopii'}</p>}
      {isOperator && picked && <MapTeleport key={dimension.id + ':' + picked.join(',')} commands={commands} running={running}
        dimension={dimension.id} x={picked[0]} z={picked[1]} />}
      {isOperator && <CommandStatus commands={commands} fromMap />}
      {isOperator && searchedPlayer && playerArea?.id === dimension.id && <p className="empty-state">
        {searchedPlayer.name} · X {searchedPlayer.x} · Y {searchedPlayer.y} · Z {searchedPlayer.z}
        {!covers(dimension, searchedPlayer) && ' · Poza terenem kopii'}</p>}
      {showPlayers && <details className="world-map-players">
        <summary>Pozycje graczy na żywo{livePlayers.length ? ' · ' + livePlayers.length : ''}</summary>
        {positions.health !== 'ok' && <p role="status">{positions.health === 'loading' ? 'Wczytywanie pozycji…' : 'Odczyt pozycji chwilowo niedostępny.'}</p>}
        {positions.health === 'ok' && !livePlayers.length && <p>Brak widocznych graczy.</p>}
        <PlayerLocations locations={livePlayers} dimensions={snapshot.dimensions} actionLabel="Pokaż na mapie gracza" onLocate={locate} />
      </details>}
      {isOperator && <details className="world-map-players">
        <summary>Ostatnie miejsca śmierci{lastDeaths.length ? ' · ' + lastDeaths.length : ''}</summary>
        {deathRead === 'loading' && <p role="status">Wczytywanie zapisów graczy…</p>}
        {deathRead === 'error' && <p role="status">Odczyt zapisów graczy jest niedostępny.</p>}
        {showLiveDeaths && (journal.health === 'error' || journal.status === 'error') && <p role="status">
          Odczyt dziennika Fabric jest niedostępny.{journal.positions.length > 0 && ' Pokazujemy ostatnie dostępne wpisy.'}
        </p>}
        {showLiveDeaths && journal.health === 'ok' && journal.status === 'waiting' && <p role="status">Oczekiwanie na dziennik Fabric.</p>}
        {deathRead === 'ok' && !deaths && !lastDeaths.length && <p>Brak zapisanych miejsc śmierci.</p>}
        {deaths && <>
          <p>Stan z importu {dateTimeFormat.format(deaths.capturedAt)}{deaths.lastDeaths.skipped > 0 &&
            ' · Pominięte pliki ' + deaths.lastDeaths.skipped}</p>
          {!lastDeaths.length && <p>Brak zapisanych miejsc śmierci.</p>}
        </>}
        <PlayerLocations locations={lastDeaths} dimensions={snapshot.dimensions} actionLabel="Pokaż ostatnie miejsce śmierci gracza" onLocate={locate} />
      </details>}
    </section>
    <Waypoints key={dimension.id} account={account} points={waypoints} loadFailed={pointsFailed}
      dimension={dimension.id} bounds={dimension.bounds} picked={picked} onFocus={(coordinate) => {
        setPicked(coordinate)
        setFocus(coordinate)
      }}
      onChange={setWaypoints} verifySession={verifySession} />
  </>
}
