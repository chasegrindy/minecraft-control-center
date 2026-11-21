import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { File as FileIcon, Folder, PackagePlus, RotateCcw, Upload } from 'lucide-react'
import type { Account } from './SessionGate'
import { Button, Notice, PanelHeading } from './ui'

const endpoint = '/api/mcc/files'
const maxModBytes = 32 * 1024 * 1024
const settings = {
  motd: { label: 'Opis na liście serwerów', type: 'text', max: 200 },
  'max-players': { label: 'Limit graczy', type: 'number', min: 0, max: 2_147_483_647 },
  difficulty: { label: 'Poziom trudności', type: 'difficulty' },
  'allow-flight': { label: 'Zezwalaj na latanie', type: 'boolean' },
  'view-distance': { label: 'Zasięg widoku', type: 'number', min: 2, max: 32 },
  'simulation-distance': { label: 'Zasięg symulacji', type: 'number', min: 2, max: 32 },
} as const
type SettingKey = keyof typeof settings
type SettingValues = Partial<Record<SettingKey, string | number | boolean | null>>
type Properties = { revision: string; values: SettingValues; invalid: SettingKey[] }
type Entry = { name: string; size: number | null }
type InstalledMod = { name: string; size: number; modifiedAt: number }
type History = { id: string; actor: string; kind: 'edit' | 'restore'; status: 'applied' | 'rejected' | 'uncertain'; requestedAt: number; after: SettingValues }
type Verdict = 'yes' | 'no' | 'unknown'
type Mod = {
  digest: string; id: string; file: string; version: string; size: number; verdict: Verdict
  checks: { id: string; target: string; verdict: Verdict }[]; dependencies: string[]
}
type ModHistory = { id: string; kind: 'install' | 'remove' | 'restore'; status: History['status']; file: string; requestedAt: number; actor: string }
type ModAction =
  | { kind: 'install'; id: string; digest: string }
  | { kind: 'remove'; id: string; file: string; size: number; modifiedAt: number }
  | { kind: 'restore'; id: string; from: string }
type FilesState = {
  configured: boolean; writable: boolean; modsWritable: boolean; entries: (Entry & { kind: 'directory' | 'file' })[]
  mods: InstalledMod[]; config: Entry[]; modHistory: ModHistory[]
  history: History[]; properties: Properties | null; staged: Mod[]
  versions: { minecraft: string; fabricloader: string; java: string }
}
type Intent =
  | { kind: 'edit'; id: string; revision: string; changes: SettingValues }
  | { kind: 'restore'; id: string; revision: string; from: string }
  | { kind: 'discard'; mod: Mod }
  | { kind: 'mod'; file: string; action: ModAction }

const date = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' })
const size = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 })
const formatSize = (bytes: number) => bytes < 1024 ? bytes + ' B' : bytes < 1024 ** 2 ? size.format(bytes / 1024) + ' KiB' : size.format(bytes / 1024 ** 2) + ' MiB'
const verdicts = { yes: 'Zgodne według metadanych', no: 'Niezgodne z instancją', unknown: 'Zgodność niepotwierdzona' }
const statuses = { applied: 'Zapisano', rejected: 'Odrzucono', uncertain: 'Wymaga weryfikacji' }
const modActions = {
  install: { label: 'Instalacja', title: 'Zainstalować mod?', result: 'Mod trafił do katalogu mods. Gra wczyta go przy następnym uruchomieniu.' },
  remove: { label: 'Odłączenie', title: 'Odłączyć mod?', result: 'Mod przeniesiono do archiwum. Możesz go przywrócić z historii.' },
  restore: { label: 'Przywrócenie', title: 'Przywrócić mod?', result: 'Mod przywrócono do aktywnego katalogu.' },
}
const errors: Record<string, string> = {
  changed: 'Plik zmienił się od ostatniego odczytu. Odśwież ustawienia i sprawdź nowe wartości.',
  running: 'Zmiana pliku wymaga zatrzymanego procesu Minecrafta.',
  'running-unknown': 'Nie udało się potwierdzić stanu procesu gry.',
  'file-permissions': 'Sprawdź właściciela plików i wspólną grupę usług MCC oraz Crafty.',
  busy: 'Inna operacja plikowa lub sterowanie grą jest w toku.',
  'mod-size': 'Wybierz plik JAR o rozmiarze do 32 MiB.',
  'mod-name': 'Nazwa pliku musi kończyć się na .jar i używać prostych znaków.',
  'fabric-metadata': 'Brak prawidłowych metadanych Fabric w pliku JAR.',
  'mod-capacity': 'Poczekalnia ma limit ośmiu plików. Usuń zbędny plik przed kolejnym przesłaniem.',
  'mod-staged': 'Pliku z poczekalni nie znaleziono lub jego zawartość się zmieniła.',
  'mod-exists': 'W instancji jest już plik o tej nazwie lub mod z tym identyfikatorem.',
  'mod-dependencies': 'Zależność lub konflikt blokuje tę zmianę.',
  'mod-inventory': 'Nie udało się wiarygodnie sprawdzić zestawu modów instancji.',
  'mod-compatibility': 'Metadane nie potwierdzają zgodności z aktualną instancją.',
  'mod-archive': 'Nie udało się zweryfikować archiwalnego pliku.',
  'mod-changed': 'Zawartość katalogu się zmieniła. Odśwież listę.',
  'unsupported-properties': 'Jedno z wybranych ustawień ma format spoza obsługiwanych wartości.',
  unchanged: 'Wybrane ustawienia mają już te wartości.',
  disabled: 'Katalog instancji nie jest dostępny dla tej operacji.',
}

function FileList({ entries }: { entries: (Entry & { kind?: 'directory' | 'file' })[] }) {
  return entries.length ? <ul className="file-list">
    {entries.map(({ name, size, kind }) => {
      const Icon = kind === 'directory' ? Folder : FileIcon
      return <li key={name}><Icon size={16} aria-hidden="true" /><span>{name}</span>{size !== null && <small>{formatSize(size)}</small>}</li>
    })}
  </ul> : <p className="empty-state">Brak plików do wyświetlenia.</p>
}

function PropertiesEditor({ properties, canSave, onEdit }: {
  properties: Properties
  canSave: boolean
  onEdit: (changes: SettingValues) => void
}) {
  const [values, setValues] = useState(properties.values)
  const keys = Object.keys(settings) as SettingKey[]
  const changes = Object.fromEntries(keys.filter((key) => values[key] !== properties.values[key] && values[key] !== null && values[key] !== undefined)
    .map((key) => [key, values[key]])) as SettingValues
  return <form className="game-command-grid file-settings" onSubmit={(event) => { event.preventDefault(); onEdit(changes) }}>
    {keys.map((key) => {
      const field = settings[key]
      const value = values[key] == null ? '' : String(values[key])
      const disabled = !canSave || properties.invalid.includes(key)
      const update = (next: string) => setValues((state) => ({ ...state, [key]: next === '' && field.type !== 'text' ? null
        : field.type === 'number' ? Number(next) : field.type === 'boolean' ? next === 'true' : next }))
      return <label key={key}>{field.label}
        {field.type === 'boolean' || field.type === 'difficulty' ? <select value={value} onChange={(event) => update(event.target.value)} disabled={disabled}>
          <option value="">Brak wartości</option>
          {field.type === 'boolean' ? <><option value="true">Tak</option><option value="false">Nie</option></>
            : <><option value="peaceful">Pokojowy</option><option value="easy">Łatwy</option><option value="normal">Normalny</option><option value="hard">Trudny</option></>}
        </select> : <input value={value} type={field.type} maxLength={field.type === 'text' ? field.max : undefined}
          min={field.type === 'number' ? field.min : undefined} max={field.type === 'number' ? field.max : undefined} step={1}
          onChange={(event) => update(event.target.value)} disabled={disabled} />}
      </label>
    })}
    <Button variant="primary" type="submit" disabled={!canSave || Object.keys(changes).length === 0}>Sprawdź zmiany</Button>
  </form>
}

export default function FileView({ account, running, verifySession }: {
  account: Account
  running: boolean | null
  verifySession: () => Promise<void>
}) {
  const [state, setState] = useState<FilesState | null>(null)
  const [intent, setIntent] = useState<Intent | null>(null)
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<File | null>(null)
  const [modCheck, setModCheck] = useState<{ digest: string; ok: boolean; text: string } | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const title = useId()
  const canSave = state?.writable === true && running === false && !pending
  const canChangeMods = state?.modsWritable === true && running === false && !pending

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(endpoint, { signal })
      if (response.status === 401) await verifySession()
      if (!response.ok) throw new Error('File catalog unavailable')
      setState(await response.json() as FilesState)
      setModCheck(null)
    } catch {
      if (!signal?.aborted) setError('Nie można odczytać katalogu plików.')
    }
  }, [verifySession])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  useEffect(() => {
    if (intent && !dialog.current?.open) dialog.current?.showModal()
    if (!intent && dialog.current?.open) dialog.current.close()
  }, [intent])

  function choose(value: Intent) {
    setStatus('')
    setError('')
    setDialogError('')
    setIntent(value)
  }

  async function request(url: string, method: string, body?: File | string, fields?: Record<string, string>) {
    const response = await fetch(url, { method, body, headers: { 'X-MCC-CSRF': account.csrf, ...fields } })
    if (response.status === 401) await verifySession()
    if (!response.ok) {
      const { error: code, details } = await response.json() as { error?: string; details?: string[] }
      const label = errors[code ?? ''] ?? 'MCC odrzuciło żądanie. Sprawdź dostęp i odśwież katalog.'
      throw new Error(details?.length ? label + ' ' + details.join(', ') : label)
    }
    return response
  }

  async function stage() {
    if (!selected || pending) return
    setStatus('')
    setError('')
    if (selected.size < 1 || selected.size > maxModBytes) { setError(errors['mod-size']); return }
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,154}\.jar$/i.test(selected.name)) { setError(errors['mod-name']); return }
    setPending(true)
    try {
      await request(endpoint + '/mods', 'POST', selected, { 'Content-Type': 'application/octet-stream', 'X-MCC-Filename': selected.name })
      setSelected(null)
      if (uploadInput.current) uploadInput.current.value = ''
      setStatus('Plik zapisano w poczekalni. Sprawdź wynik zgodności poniżej.')
      await load()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Przesłanie nie powiodło się.')
    } finally {
      setPending(false)
    }
  }

  async function checkMod(mod: Mod, install: boolean) {
    if (pending) return
    setPending(true)
    setModCheck(null)
    try {
      const response = await request(endpoint + '/mods/' + mod.digest + '/check', 'POST')
      const { checkedAt } = await response.json() as { checkedAt: number }
      setModCheck({ digest: mod.digest, ok: true, text: 'Zależności dodatku spełnione, metadane bez konfliktów · ' + date.format(checkedAt) })
      if (install) choose({ kind: 'mod', file: mod.file, action: { kind: 'install', id: crypto.randomUUID(), digest: mod.digest } })
    } catch (problem) {
      setModCheck({ digest: mod.digest, ok: false,
        text: problem instanceof Error ? problem.message : 'Sprawdzenie zestawu modów nie powiodło się.' })
    } finally {
      setPending(false)
    }
  }

  async function apply() {
    if (!intent || pending) return
    setPending(true)
    setDialogError('')
    try {
      if (intent.kind === 'discard') {
        await request(endpoint + '/mods/' + intent.mod.digest, 'DELETE')
        setStatus('Plik usunięto z poczekalni.')
      } else if (intent.kind === 'mod') {
        const response = await request(endpoint + '/mod-actions', 'POST', JSON.stringify({ ...intent.action, confirmed: true }),
          { 'Content-Type': 'application/json' })
        const data: { operation: ModHistory } = await response.json()
        setStatus(data.operation.status === 'applied' ? modActions[intent.action.kind].result
          : data.operation.status === 'rejected' ? 'Zmiana modu została odrzucona.' : 'Sprawdź pliki instancji przed powtórzeniem operacji.')
      } else {
        const response = await request(endpoint, 'POST', JSON.stringify({ ...intent, confirmed: true }), { 'Content-Type': 'application/json' })
        const data: { operation: History } = await response.json()
        setStatus(data.operation.status === 'applied' ? 'Zapisano ustawienia. Zaczną obowiązywać po uruchomieniu gry.'
          : 'Zapis wymaga weryfikacji. Sprawdź stan i historię pliku.')
      }
      setIntent(null)
      await load()
    } catch (problem) {
      setDialogError(problem instanceof Error ? problem.message : 'Nie udało się zatwierdzić operacji.')
    } finally {
      setPending(false)
    }
  }

  return <>
    {error && <div role="alert"><Notice title={error} tone="error" /></div>}
    {status && <div role="status"><Notice title={status} /></div>}
    <section className="panel" aria-label="Pliki instancji">
      <PanelHeading title="Pliki instancji"><Button onClick={() => { setError(''); void load() }} disabled={pending}>Odśwież</Button></PanelHeading>
      {state === null && !error && <p className="empty-state" role="status">Wczytywanie katalogu…</p>}
      {state && !state.configured && <p className="empty-state">Katalog instancji nie jest jeszcze podłączony do MCC.</p>}
      {state?.configured && <>
        <FileList entries={state.entries} />
        <details className="file-details"><summary>Mody na serwerze</summary>
          {state.mods.length > 0 ? <ul className="waypoint-list">
            {state.mods.map((mod) => <li key={mod.name}>
              <span className="event-icon"><FileIcon size={16} aria-hidden="true" /></span>
              <div><strong>{mod.name}</strong><p>{formatSize(mod.size)}</p></div>
              <div className="world-map-actions"><Button disabled={!canChangeMods} aria-label={'Odłącz: ' + mod.name} onClick={() => choose({
                kind: 'mod', file: mod.name, action: { kind: 'remove', id: crypto.randomUUID(), file: mod.name, size: mod.size, modifiedAt: mod.modifiedAt },
              })}>Odłącz</Button></div>
            </li>)}
          </ul> : <p className="empty-state">Brak plików do wyświetlenia.</p>}
        </details>
        <details className="file-details"><summary>Pliki katalogu config</summary><FileList entries={state.config} /></details>
      </>}
    </section>
    {state?.properties && <section className="panel game-command-panel" aria-label="Ustawienia pliku server.properties">
      <PanelHeading title="Ustawienia serwera" description="Wybrane pola server.properties" />
      {!state.writable && <p className="empty-state">Edycja plików jest wyłączona w konfiguracji MCC.</p>}
      {state.writable && running !== false && <p className="empty-state">Do zapisania potrzebny jest potwierdzony stan zatrzymania gry.</p>}
      <PropertiesEditor key={state.properties.revision} properties={state.properties} canSave={canSave}
        onEdit={(changes) => { if (state.properties) choose({ kind: 'edit', id: crypto.randomUUID(), revision: state.properties.revision, changes }) }} />
      {state.history.length > 0 && <div className="file-details">
        <h3>Historia zmian ustawień</h3>
        <ul className="waypoint-list">
          {state.history.map((event) => <li key={event.id}>
            <span className="event-icon"><RotateCcw size={16} aria-hidden="true" /></span>
            <div><strong>{event.kind === 'restore' ? 'Przywrócenie' : 'Edycja ustawień'}</strong>
              <p>{date.format(event.requestedAt)} · {event.actor} · {statuses[event.status]}</p>
              <p>{Object.keys(event.after).map((key) => settings[key as SettingKey].label).join(', ')}</p>
            </div>
            {event.status === 'applied' && <div className="world-map-actions">
              <Button disabled={!canSave} onClick={() => {
                if (state.properties) choose({ kind: 'restore', id: crypto.randomUUID(), revision: state.properties.revision, from: event.id })
              }}>Przywróć poprzednie wartości</Button>
            </div>}
          </li>)}
        </ul>
      </div>}
    </section>}
    {state && <section className="panel game-command-panel" aria-label="Poczekalnia modów">
      <PanelHeading title="Poczekalnia modów" description={'Minecraft ' + state.versions.minecraft + ' · Fabric ' + state.versions.fabricloader + ' · Java ' + state.versions.java} />
      {state.modsWritable ? running !== false && <p className="empty-state">Instalacja i odłączanie wymagają zatrzymanej gry.</p>
        : <p className="empty-state">Zmiany modów w instancji są wyłączone w konfiguracji MCC.</p>}
      <form className="game-command-grid file-settings" onSubmit={(event) => { event.preventDefault(); void stage() }}>
        <label>Plik moda JAR<input ref={uploadInput} type="file" accept=".jar" disabled={pending}
          onChange={(event) => setSelected(event.target.files?.[0] ?? null)} /></label>
        <Button variant="primary" type="submit" disabled={!selected || pending}><Upload size={16} aria-hidden="true" /> Prześlij i sprawdź</Button>
      </form>
      {state.staged.length > 0 && <ul className="waypoint-list">
        {state.staged.map((mod) => <li key={mod.digest}>
          <span className="event-icon"><PackagePlus size={18} aria-hidden="true" /></span>
          <div><strong>{mod.file}</strong>
            <p>{mod.id} · {mod.version} · {formatSize(mod.size)} · {verdicts[mod.verdict]}</p>
            {mod.dependencies.length > 0 && <p>Wymagane dodatki {mod.dependencies.join(', ')}</p>}
            <details className="file-details"><summary>Wynik według składników</summary>
              <ul className="file-checks">{mod.checks.map((check) => <li key={check.id}>{check.id} {check.target} · {verdicts[check.verdict]}</li>)}</ul>
              <code>{mod.digest}</code>
            </details>
            {modCheck?.digest === mod.digest && <p role={modCheck.ok ? 'status' : 'alert'}>{modCheck.text}</p>}
          </div>
          <div className="world-map-actions">
            <Button disabled={pending || !state.entries.some(({ name }) => name === 'mods') || mod.verdict !== 'yes'}
              onClick={() => void checkMod(mod, false)}>Sprawdź zestaw modów</Button>
            <Button disabled={!canChangeMods || mod.verdict !== 'yes'} onClick={() => void checkMod(mod, true)}>Zainstaluj</Button>
            <Button disabled={pending} onClick={() => choose({ kind: 'discard', mod })}
              aria-label={'Usuń z poczekalni: ' + mod.file}>Usuń z poczekalni</Button>
          </div>
        </li>)}
      </ul>}
    </section>}
    {!!state?.modHistory.length && <section className="panel" aria-label="Historia zmian modów">
      <PanelHeading title="Historia zmian modów" />
      <ul className="waypoint-list">
        {state.modHistory.map((item) => <li key={item.id}>
          <span className="event-icon"><RotateCcw size={16} aria-hidden="true" /></span>
          <div><strong>{item.file}</strong><p>{modActions[item.kind].label} · {statuses[item.status]} · {date.format(item.requestedAt)} · {item.actor}</p></div>
          {item.kind === 'remove' && item.status !== 'rejected' && <div className="world-map-actions">
            <Button disabled={!canChangeMods || state.mods.some(({ name }) => name.toLowerCase() === item.file.toLowerCase())}
              onClick={() => choose({ kind: 'mod', file: item.file, action: { kind: 'restore', id: crypto.randomUUID(), from: item.id } })}>Przywróć mod</Button>
          </div>}
        </li>)}
      </ul>
    </section>}
    <dialog ref={dialog} aria-labelledby={title} onClose={() => setIntent(null)} onCancel={(event) => { if (pending) event.preventDefault() }}>
      <h2 id={title}>{intent?.kind === 'mod' ? modActions[intent.action.kind].title
        : intent?.kind === 'discard' ? 'Usunąć plik z poczekalni?' : intent?.kind === 'restore'
        ? 'Przywrócić poprzednie ustawienia?' : 'Zapisać ustawienia serwera?'}</h2>
      {intent?.kind === 'edit' && <ul className="file-confirm-list">
        {Object.entries(intent.changes).map(([key, value]) => <li key={key}>{settings[key as SettingKey].label} <strong>{String(value)}</strong></li>)}
      </ul>}
      {intent?.kind === 'discard' && <p>{intent.mod.file}</p>}
      {intent?.kind === 'mod' && <p>{intent.file}. {intent.action.kind === 'remove'
        ? 'Plik trafi do archiwum i będzie można go przywrócić.' : 'Gra wczyta plik przy następnym uruchomieniu.'}</p>}
      {intent?.kind === 'restore' && <p>MCC przywróci wartości z wybranej pozycji historii.</p>}
      {dialogError && <div role="alert"><Notice title={dialogError} tone="error" /></div>}
      <div className="dialog-actions">
        <Button autoFocus disabled={pending} onClick={() => setIntent(null)}>Anuluj</Button>
        <Button variant={intent?.kind === 'discard' ? 'danger' : 'primary'} loading={pending} onClick={() => void apply()}>
          {intent?.kind === 'discard' ? 'Usuń plik' : 'Potwierdź'}
        </Button>
      </div>
    </dialog>
  </>
}
