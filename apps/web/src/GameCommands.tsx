import { useEffect, useId, useRef, useState } from 'react'
import { CloudSun, MapPin, Shield, Terminal } from 'lucide-react'
import { Button, Notice, PanelHeading } from './ui'
import { positionDimensions } from './player-positions'

const endpoint = '/api/mcc/commands'
type Intent = { id: string; command: string; fromMap: boolean }
type Feedback = { text: string; error: boolean; fromMap: boolean }

export function useGameCommands(active: boolean, csrf: string, verifySession: () => Promise<void>) {
  const [mode, setMode] = useState<'disabled' | 'list' | 'manage'>('disabled')
  const [availabilityError, setAvailabilityError] = useState(false)
  const [intent, setIntent] = useState<Intent | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [dialogError, setDialogError] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const enabled = active && mode !== 'disabled'
  const listOnly = enabled && mode === 'list'
  const canManage = enabled && mode === 'manage'

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(endpoint, { signal: controller.signal })
        if (response.status === 401) await verifySession()
        if (!response.ok) throw new Error('Command state unavailable')
        const state: { enabled: boolean; mode?: 'list' | 'manage' } = await response.json()
        setMode(state.enabled ? state.mode ?? 'manage' : 'disabled')
        setAvailabilityError(false)
      } catch {
        if (!controller.signal.aborted) setAvailabilityError(true)
      }
    }
    void load()
    return () => controller.abort()
  }, [active, verifySession])

  function request(command: string, fromMap = false) {
    if (!enabled || busy || intent || (listOnly && command !== 'list')) return
    setFeedback(null)
    setDialogError('')
    setIntent({ id: crypto.randomUUID(), command, fromMap })
  }

  async function confirm() {
    if (!intent || busy) return
    setBusy(true)
    setDialogError('')
    const { id, command, fromMap } = intent
    function report(text: string, error: boolean) {
      setFeedback({ text, error, fromMap })
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MCC-CSRF': csrf },
        body: JSON.stringify({ id, command, confirmed: true }),
      })
      const result: { outcome?: string; error?: string } = await response.json()
      if (response.status === 401) await verifySession()
      if (response.status === 429) {
        setDialogError('Inna komenda jest przetwarzana. Spróbuj ponownie za chwilę.')
        return
      }
      setIntent(null)
      if (!response.ok) {
        if (response.status === 503) setMode('disabled')
        const text = result.error === 'format' ? 'MCC nie obsługuje tej komendy lub jej argumentów.'
          : result.error === 'power' ? 'Najpierw zakończ operację sterowania serwerem.'
            : result.error === 'mode' ? 'W tym trybie dostępny jest odczyt listy graczy.'
              : 'MCC odrzuciło żądanie. Sprawdź uprawnienia i dostępność komend.'
        report(text, true)
      } else if (result.outcome === 'submitted') {
        setHistory((previous) => [...previous, command].slice(-20))
        report('Crafty przyjęło komendę. Wynik gry pojawi się w konsoli.', false)
      } else if (result.outcome === 'rejected') {
        report('Crafty odrzuciło komendę. Sprawdź status serwera i uprawnienia klucza.', true)
      } else {
        report('Wynik jest niepewny. Sprawdź logi gry przed wysłaniem kolejnej komendy.', true)
      }
    } catch {
      setDialogError('Brak odpowiedzi MCC. Ponowienie w tym oknie użyje tego samego zgłoszenia.')
    } finally {
      setBusy(false)
    }
  }

  return { enabled, listOnly, canManage, availabilityError, intent, busy, feedback, dialogError, history, request, confirm, cancel: () => setIntent(null) }
}

export type Commands = ReturnType<typeof useGameCommands>
export function CommandConfirmation({ commands }: { commands: Commands }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  useEffect(() => {
    const element = dialog.current
    if (commands.intent && element && !element.open) element.showModal()
    else if (!commands.intent && element?.open) element.close()
  }, [commands.intent])

  return <dialog ref={dialog} aria-labelledby={title} onClose={() => { if (commands.intent) commands.cancel() }}
    onCancel={(event) => { if (commands.busy) event.preventDefault() }}>
    <h2 id={title}>Wysłać komendę do Minecrafta?</h2>
    {commands.intent && <p className="command-preview"><code>{commands.intent.command}</code></p>}
    {commands.dialogError && <div role="alert"><Notice title={commands.dialogError} tone="error" /></div>}
    <div className="dialog-actions">
      <Button autoFocus disabled={commands.busy} onClick={commands.cancel}>Anuluj</Button>
      <Button variant="primary" loading={commands.busy} onClick={() => void commands.confirm()}>Wyślij komendę</Button>
    </div>
  </dialog>
}

export function CommandStatus({ commands, fromMap = false }: { commands: Commands; fromMap?: boolean }) {
  if (commands.feedback?.fromMap === fromMap) return <div role={commands.feedback.error ? 'alert' : 'status'}>
    <Notice title={commands.feedback.text} tone={commands.feedback.error ? 'error' : 'success'} />
  </div>
  if (fromMap) return null
  if (commands.availabilityError) return <Notice title="Sprawdzenie dostępu do komend nie powiodło się" tone="error" />
  if (!commands.enabled) return <p className="empty-state">Wysyłanie komend z MCC jest wyłączone.</p>
  if (commands.listOnly) return <p className="empty-state">Tryb próby udostępnia odczyt listy graczy w Konsoli.</p>
  return null
}

const teleportDimensions = {
  overworld: { id: 'minecraft:overworld', bottom: -64, top: 319 },
  nether: { id: 'minecraft:the_nether', bottom: 0, top: 255 },
  end: { id: 'minecraft:the_end', bottom: 0, top: 255 },
} as const

export function MapTeleport({ commands, running, dimension, x, z }: {
  commands: Commands; running: boolean; dimension: keyof typeof teleportDimensions; x: number; z: number
}) {
  if (!commands.canManage || Math.abs(x) >= 30_000_000 || Math.abs(z) >= 30_000_000) return null
  const { id, bottom, top } = teleportDimensions[dimension]
  return <details className="world-map-players">
    <summary>Teleportuj gracza do wskazanego punktu</summary>
    <p>{positionDimensions[dimension]} · X {x} · Z {z}</p>
    <p>Podaj bezpieczną wysokość lądowania. Mapa z kopii nie sprawdza bieżących bloków.</p>
    {!running && <p role="status">Teleportacja będzie dostępna, gdy gra odpowie.</p>}
    <div className="game-command-grid">
      <form onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const height = Number(form.get('height'))
        commands.request(`execute in ${id} run teleport ${form.get('player')} ${x} ${height} ${z}`, true)
      }}>
        <label>Nazwa gracza<input name="player" pattern="[A-Za-z0-9_]{1,16}" maxLength={16} autoComplete="off"
          required disabled={!running || commands.busy} /></label>
        <label>Wysokość Y<input name="height" type="number" min={bottom} max={top} step={1}
          required disabled={!running || commands.busy} /></label>
        <Button disabled={!running || commands.busy} type="submit"><MapPin size={16} aria-hidden="true" /> Sprawdź cel teleportacji</Button>
      </form>
    </div>
  </details>
}

const rules = {
  keep_inventory: 'Zachowaj ekwipunek po śmierci',
  advance_time: 'Upływ czasu',
  advance_weather: 'Zmiany pogody',
  spawn_mobs: 'Pojawianie się mobów',
  players_sleeping_percentage: 'Gracze potrzebni do przespania nocy (%)',
} as const

export function WorldControls({ commands, running }: { commands: Commands; running: boolean }) {
  const [weather, setWeather] = useState('clear')
  const [time, setTime] = useState('day')
  const [rule, setRule] = useState<keyof typeof rules>('keep_inventory')
  const [booleanValue, setBooleanValue] = useState('true')
  const [sleeping, setSleeping] = useState('50')
  const disabled = !running || commands.busy
  return <section className="panel game-command-panel" aria-label="Sterowanie światem">
    <PanelHeading title="Sterowanie światem" />
    <CommandStatus commands={commands} />
    {commands.canManage && <div className="game-command-grid">
      <form onSubmit={(event) => { event.preventDefault(); commands.request('weather ' + weather) }}>
        <label>Pogoda<select value={weather} onChange={(event) => setWeather(event.target.value)} disabled={disabled}>
          <option value="clear">Bez opadów</option><option value="rain">Deszcz</option><option value="thunder">Burza</option>
        </select></label>
        <Button disabled={disabled} type="submit"><CloudSun size={17} aria-hidden="true" /> Ustaw pogodę</Button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); commands.request('time set ' + time) }}>
        <label>Pora dnia<select value={time} onChange={(event) => setTime(event.target.value)} disabled={disabled}>
          <option value="day">Dzień</option><option value="noon">Południe</option><option value="night">Noc</option><option value="midnight">Północ</option>
        </select></label>
        <Button disabled={disabled} type="submit">Ustaw porę dnia</Button>
      </form>
      <form onSubmit={(event) => {
        event.preventDefault()
        commands.request('gamerule minecraft:' + rule + ' ' + (rule === 'players_sleeping_percentage' ? sleeping : booleanValue))
      }}>
        <label>Reguła gry<select value={rule} onChange={(event) => setRule(event.target.value as keyof typeof rules)} disabled={disabled}>
          {Object.entries(rules).map(([name, label]) => <option key={name} value={name}>{label}</option>)}
        </select></label>
        {rule === 'players_sleeping_percentage'
          ? <label>Wartość<input type="number" value={sleeping} min={0} max={100} step={1} required
            onChange={(event) => setSleeping(event.target.value)} disabled={disabled} /></label>
          : <label>Wartość<select value={booleanValue} onChange={(event) => setBooleanValue(event.target.value)} disabled={disabled}>
            <option value="true">Włączona</option><option value="false">Wyłączona</option>
          </select></label>}
        <div className="game-command-actions">
          <Button type="submit" disabled={disabled}>Ustaw regułę</Button>
          <Button disabled={disabled} onClick={() => commands.request('gamerule minecraft:' + rule)}>Odczytaj w konsoli</Button>
        </div>
      </form>
      <Button disabled={disabled} onClick={() => commands.request('save-all')}>Zapisz świat</Button>
    </div>}
    {commands.canManage && !running && <p className="empty-state">Komendy będą dostępne po uruchomieniu gry i odczycie statusu.</p>}
  </section>
}

export function PlayerControls({ commands, running }: { commands: Commands; running: boolean }) {
  const [player, setPlayer] = useState('')
  const [action, setAction] = useState('kick')
  const [whitelist, setWhitelist] = useState('list')
  const disabled = !running || commands.busy
  const whitelistNeedsPlayer = whitelist === 'add' || whitelist === 'remove'
  return <section className="panel game-command-panel" aria-label="Zarządzanie graczami">
    <PanelHeading title="Zarządzanie graczami" />
    <CommandStatus commands={commands} />
    {commands.canManage && <div className="game-command-grid">
      <form onSubmit={(event) => { event.preventDefault(); commands.request(action + ' ' + player) }}>
        <label>Nazwa gracza<input type="text" value={player} maxLength={16} pattern="[A-Za-z0-9_]{1,16}"
          autoComplete="off" required disabled={disabled} onChange={(event) => setPlayer(event.target.value)} /></label>
        <label>Akcja<select value={action} onChange={(event) => setAction(event.target.value)} disabled={disabled}>
          <option value="kick">Wyrzuć</option><option value="ban">Zbanuj</option><option value="pardon">Odbanuj</option>
          <option value="op">Nadaj OP</option><option value="deop">Odbierz OP</option>
        </select></label>
        <Button type="submit" disabled={disabled}><Shield size={16} aria-hidden="true" /> Wybierz akcję gracza</Button>
      </form>
      <form onSubmit={(event) => {
        event.preventDefault()
        const username = new FormData(event.currentTarget).get('player')
        commands.request('whitelist ' + whitelist + (whitelistNeedsPlayer ? ' ' + username : ''))
      }}>
        <label>Whitelista<select value={whitelist} onChange={(event) => setWhitelist(event.target.value)} disabled={disabled}>
          <option value="list">Wyświetl w konsoli</option><option value="on">Włącz</option><option value="off">Wyłącz</option>
          <option value="add">Dodaj gracza</option><option value="remove">Usuń gracza</option>
        </select></label>
        {whitelistNeedsPlayer && <label>Gracz na whiteliście<input name="player" pattern="[A-Za-z0-9_]{1,16}"
          required maxLength={16} autoComplete="off" disabled={disabled} /></label>}
        <Button type="submit" disabled={disabled}><Terminal size={16} aria-hidden="true" /> Wybierz akcję whitelisty</Button>
      </form>
    </div>}
    {commands.canManage && !running && <p className="empty-state">Komendy będą dostępne po uruchomieniu gry i odczycie statusu.</p>}
  </section>
}
