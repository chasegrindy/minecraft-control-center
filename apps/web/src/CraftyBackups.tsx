import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CalendarClock, Download, RefreshCw } from 'lucide-react'
import type { Account } from './SessionGate'
import { Button, Notice, PanelHeading } from './ui'

const path = '/api/mcc/backup-jobs'
type Archive = { name: string; size: number; files: number; modifiedAt: number }
type Schedule = { enabled: boolean; time: string; allowDowntime: boolean }
const jobStatuses = {
  pending: 'W toku', done: 'Kopia sprawdzona', rejected: 'Odrzucono', uncertain: 'Wymaga sprawdzenia',
  'restore-review': 'Przywrócenie przyjęte przez Crafty', acknowledged: 'Sprawdzono w Crafty', skipped: 'Zaplanowana kopia pominięta',
}
type RestoreMode = 'files' | 'world'
type Job = { id: string; kind: 'create' | 'restore'; status: keyof typeof jobStatuses; target?: string; archive?: Archive;
  requestedAt: number; reason?: string; mode?: RestoreMode; worldSwap?: boolean; worldOutcome?: 'original' }
type State = { enabled: boolean; blocked: boolean; schedule: Schedule | null; history: Job[]; worldRestore?: boolean }
type Inventory = { shutdown: boolean; archives: Archive[]; usage?: { bytes: number; count: number } }
type Intent =
  | { kind: 'create'; id: string; allowDowntime: boolean }
  | { kind: 'schedule'; schedule: Schedule }
  | { kind: 'restore'; id: string; target: string; allowDowntime: false; mode: RestoreMode }
  | { kind: 'acknowledge'; id: string }
  | { kind: 'recover-world'; id: string }

const errors: Record<string, string> = {
  'backup-busy': 'Inna operacja trwa lub czeka na sprawdzenie.',
  'backup-profile': 'Profil kopii Crafty jest niedostępny lub ma nieobsługiwane ustawienia.',
  'backup-running': 'Zatrzymaj grę albo zezwól na przerwę w profilu kopii.',
  'backup-retention': 'Limit kopii w Crafty nie zostawia miejsca na kopię bezpieczeństwa.',
  'backup-source': 'Wybrane archiwum zmieniło się lub nie przeszło kontroli.',
  'backup-timeout': 'MCC nie potwierdziło utworzenia gotowego archiwum. Sprawdź Crafty.',
  'backup-extra': 'Pojawiło się kilka nowych archiwów. Sprawdź historię Crafty.',
  'backup-request': 'Sprawdź stan operacji w Crafty.',
  'backup-rejected': 'Crafty odrzuciło polecenie. Sprawdź uprawnienia klucza.',
  'backup-journal': 'Dziennik zadań kopii jest niedostępny.',
  'world-disabled': 'Przywracanie świata jest wyłączone w konfiguracji MCC.',
  'world-name': 'Folder w archiwum nie odpowiada nazwie świata w ustawieniach serwera.',
  'world-changed': 'Stan świata zmienił się podczas przygotowania kopii.',
  'world-extract': 'Nie udało się sprawdzić i wypakować plików świata.',
  'world-space': 'Za mało miejsca na wypakowanie świata.',
  'world-storage': 'Katalog odzyskiwania musi leżeć na tym samym systemie plików co serwer.',
  'world-permissions': 'Sprawdź właściciela świata i wspólną grupę usług MCC oraz Crafty.',
  'world-swap': 'Nie udało się podmienić świata. Poprzedni zapis jest aktywny.',
  'world-recovery': 'Sprawdź stan świata przed wznowieniem gry.',
}
const titles = {
  create: 'Utworzyć kopię zapasową?',
  schedule: 'Zapisać harmonogram kopii?',
  restore: 'Przywrócić pliki z kopii?',
  acknowledge: 'Potwierdzić sprawdzenie w Crafty?',
  'recover-world': 'Sprawdzić stan świata?',
}
const date = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' })
const number = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 })
const showSize = (bytes: number) => bytes >= 2 ** 30
  ? number.format(bytes / 2 ** 30) + ' GiB' : number.format(bytes / 2 ** 20) + ' MiB'

function jobLabel(job: Job) {
  if (job.mode === 'world' && job.status === 'done') return 'Świat przywrócony'
  if (job.worldOutcome === 'original') return 'Poprzedni świat jest aktywny'
  return jobStatuses[job.status]
}

function ScheduleForm({ current, disabled, shutdown, onSubmit }: {
  current: Schedule | null
  disabled: boolean
  shutdown: boolean
  onSubmit: (input: Schedule) => void
}) {
  const [time, setTime] = useState(current?.time ?? '04:00')
  const [enabled, setEnabled] = useState(current?.enabled ?? false)
  const [allowDowntime, setAllowDowntime] = useState(current?.allowDowntime ?? false)
  return <form className="crafty-backup-schedule" onSubmit={(event) => {
    event.preventDefault()
    onSubmit({ enabled, time, allowDowntime: allowDowntime && shutdown })
  }}>
    <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={disabled} /> Kopia codziennie</label>
    <label>Godzina w Polsce <input type="time" required value={time} disabled={disabled} onChange={(event) => setTime(event.target.value)} /></label>
    <label><input type="checkbox" checked={allowDowntime && shutdown} disabled={disabled || !shutdown}
      onChange={(event) => setAllowDowntime(event.target.checked)} /> Zezwól na przerwę w grze</label>
    <Button type="submit" disabled={disabled}><CalendarClock size={16} aria-hidden="true" /> Zapisz harmonogram</Button>
  </form>
}

export default function CraftyBackups({ account, running, verifySession }: {
  account: Account
  running: boolean | null
  verifySession: () => Promise<void>
}) {
  const [state, setState] = useState<State | null>(null)
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [intent, setIntent] = useState<Intent | null>(null)
  const [pending, setPending] = useState(false)
  const [allowDowntime, setAllowDowntime] = useState(false)
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const newest = state?.history[0]
  const inProgress = newest?.status === 'pending'
  const canAcknowledge = newest?.status === 'uncertain' || newest?.status === 'restore-review'
  const restoreMode = state?.worldRestore ? 'world' : 'files'
  const canRequest = state?.enabled && !state.blocked && inventory && !pending

  const fetchState = useCallback(async (url: string, signal?: AbortSignal) => {
    const response = await fetch(url, { signal })
    if (response.status === 401) await verifySession()
    if (!response.ok) {
      const data = await response.json() as { error?: string }
      throw new Error(errors[data.error ?? ''] ?? 'Odczyt kopii Crafty jest chwilowo niedostępny.')
    }
    return response.json()
  }, [verifySession])

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await fetchState(path, signal) as State
      setState(result)
      if (result.enabled && result.history[0]?.status !== 'pending') {
        setInventory(await fetchState(path + '/files', signal) as Inventory)
      }
      setError('')
    } catch (problem) {
      if (!signal?.aborted) setError(problem instanceof Error ? problem.message : 'Odczyt kopii nie powiódł się.')
    }
  }, [fetchState])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (!inProgress) return
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [inProgress, load])

  useEffect(() => {
    if (intent && !dialog.current?.open) dialog.current?.showModal()
    if (!intent && dialog.current?.open) dialog.current.close()
  }, [intent])

  function choose(value: Intent) {
    setDialogError('')
    setIntent(value)
  }

  async function apply() {
    if (!intent || pending) return
    setPending(true)
    setDialogError('')
    try {
      const command = intent.kind === 'schedule' ? { kind: intent.kind, ...intent.schedule } : intent
      const response = await fetch(path, { method: 'POST', body: JSON.stringify({ ...command, confirmed: true }),
        headers: { 'Content-Type': 'application/json', 'X-MCC-CSRF': account.csrf } })
      if (response.status === 401) await verifySession()
      const data = await response.json() as State & { error?: string }
      if (!response.ok) throw new Error(errors[data.error ?? ''] ?? 'Nie udało się zatwierdzić operacji.')
      setState(data)
      setIntent(null)
      if (data.history[0]?.status !== 'pending') void load()
    } catch (problem) {
      setDialogError(problem instanceof Error ? problem.message : 'Nie udało się zatwierdzić operacji.')
    } finally {
      setPending(false)
    }
  }

  return <section className="panel backup-panel" aria-label="Kopie na Oracle">
    <PanelHeading title="Kopie na Oracle" description="Dedykowany profil Crafty">
      <Button onClick={() => { setError(''); void load() }} disabled={pending || inProgress}><RefreshCw size={15} aria-hidden="true" /> Odśwież</Button>
    </PanelHeading>
    {error && <div role="alert"><Notice title={error} tone="error" /></div>}
    {state === null && !error && <p className="empty-state" role="status">Wczytywanie stanu kopii…</p>}
    {state && !state.enabled && <p className="empty-state">Operacje na kopiach Crafty są wyłączone w tej konfiguracji MCC.</p>}
    {state?.enabled && <>
      {newest && <p className="empty-state" role="status">
        {jobLabel(newest)} · {date.format(newest.requestedAt)}
        {newest.archive ? ' · ' + newest.archive.name : ''}
        {newest.reason && errors[newest.reason] ? ' · ' + errors[newest.reason] : ''}
      </p>}
      {canAcknowledge && newest && <div className="world-map-actions">
        {newest.worldSwap
          ? <Button disabled={pending || running !== false || !state.worldRestore}
              onClick={() => choose({ kind: 'recover-world', id: newest.id })}>Sprawdź stan świata</Button>
          : <Button disabled={pending} onClick={() => choose({ kind: 'acknowledge', id: newest.id })}>Sprawdziłem w Crafty</Button>}
      </div>}
      <div className="crafty-backup-schedule">
        <Button variant="primary" disabled={!canRequest || running === null || (running && (!allowDowntime || !inventory?.shutdown))}
          onClick={() => choose({ kind: 'create', id: crypto.randomUUID(), allowDowntime })}>Utwórz kopię</Button>
        {inventory?.shutdown && <label><input type="checkbox" checked={allowDowntime}
          onChange={(event) => setAllowDowntime(event.target.checked)} /> Zezwól na przerwę dla tej kopii</label>}
      </div>
      <details className="backup-details"><summary>Harmonogram{state.schedule?.enabled ? ' · ' + state.schedule.time : ''}</summary>
        <ScheduleForm key={JSON.stringify(state.schedule)} current={state.schedule}
          disabled={pending || inProgress || (!inventory && !state.schedule?.enabled)} shutdown={inventory?.shutdown ?? state.schedule?.allowDowntime ?? false}
          onSubmit={(schedule) => choose({ kind: 'schedule', schedule })} />
      </details>
      {inventory?.usage && <p className="empty-state">Miejsce zajęte przez archiwa ZIP ({inventory.usage.count}) · {showSize(inventory.usage.bytes)}</p>}
      {!!inventory?.archives.length && <ul className="waypoint-list backup-list">
        {inventory.archives.map((archive) => <li key={archive.name}>
          <span className="event-icon"><Download size={16} aria-hidden="true" /></span>
          <div><strong>{archive.name}</strong><p>{showSize(archive.size)} · {archive.files} plików</p><p>{date.format(archive.modifiedAt)}</p></div>
          <div className="world-map-actions">
            <a className="button secondary" href={path + '/download/' + archive.name} download>Pobierz ZIP</a>
            <Button disabled={!canRequest || running !== false}
              onClick={() => choose({ kind: 'restore', id: crypto.randomUUID(), target: archive.name, allowDowntime: false, mode: restoreMode })}>
              {restoreMode === 'world' ? 'Przywróć świat' : 'Przywróć pliki'}</Button>
          </div>
        </li>)}
      </ul>}
      {inventory?.archives.length === 0 && <p className="empty-state">Brak archiwów z potwierdzonym zapisem świata.</p>}
      {state.history.length > 1 && <details className="backup-details"><summary>Historia operacji</summary>
        <ul className="file-list">{state.history.map((entry) => <li key={entry.id}>
          <time dateTime={new Date(entry.requestedAt).toISOString()}>{date.format(entry.requestedAt)}</time>
          <span>{entry.kind === 'restore' ? 'Przywrócenie' : 'Kopia'} · {jobLabel(entry)}</span>
        </li>)}</ul>
      </details>}
    </>}
    <dialog ref={dialog} aria-labelledby={title} onClose={() => setIntent(null)} onCancel={(event) => { if (pending) event.preventDefault() }}>
      <h2 id={title}>{intent?.kind === 'restore' && intent.mode === 'world' ? 'Przywrócić cały świat?' : intent ? titles[intent.kind] : ''}</h2>
      {intent?.kind === 'create' && <p>{intent.allowDowntime ? 'Crafty może zatrzymać grę na czas kopiowania.' : 'MCC utworzy kopię, jeśli gra będzie zatrzymana.'}</p>}
      {intent?.kind === 'schedule' && <p>{intent.schedule.enabled ? 'Codziennie o ' + intent.schedule.time + ' czasu polskiego. '
        + (intent.schedule.allowDowntime ? 'Crafty może przerwać grę podczas kopiowania.' : 'Kopia powstanie tylko przy zatrzymanej grze.') : 'MCC wyłączy zaplanowane kopie.'}</p>}
      {intent?.kind === 'restore' && <p>{intent.target}. {intent.mode === 'world'
        ? 'MCC utworzy kopię bezpieczeństwa, podmieni cały świat na ten z archiwum i zachowa poprzedni zapis do odzyskania.'
        : 'MCC utworzy kopię bezpieczeństwa, a następnie zleci Crafty przywrócenie plików w miejscu.'}</p>}
      {intent?.kind === 'acknowledge' && <p>Potwierdzenie zwolni blokadę sterowania w MCC. Użyj po sprawdzeniu wyniku w Crafty.</p>}
      {intent?.kind === 'recover-world' && <p>MCC sprawdzi, który zapis jest aktywny. Jeżeli gra nie ma aktywnego świata, MCC spróbuje przywrócić poprzedni zapis.</p>}
      {dialogError && <div role="alert"><Notice title={dialogError} tone="error" /></div>}
      <div className="dialog-actions">
        <Button autoFocus disabled={pending} onClick={() => setIntent(null)}>Anuluj</Button>
        <Button variant={intent?.kind === 'restore' ? 'danger' : 'primary'} loading={pending} onClick={() => void apply()}>Potwierdź</Button>
      </div>
    </dialog>
  </section>
}
