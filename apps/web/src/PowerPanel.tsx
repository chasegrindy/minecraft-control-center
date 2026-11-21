import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, RotateCw, Square } from 'lucide-react'
import { Button, Notice, PanelHeading } from './ui'

type Action = 'start' | 'stop' | 'restart'
type Operation = { id: string; action: Action; status: 'pending' | 'done' | 'rejected' | 'uncertain' | 'acknowledged'; reason?: string }
type State = { enabled: boolean; operation: Operation | null }
const endpoint = '/api/mcc/power'
const commands = {
  start: { label: 'Uruchom', icon: Play, confirm: 'Uruchomić Minecrafta?' },
  stop: { label: 'Zatrzymaj', icon: Square, confirm: 'Zatrzymać Minecrafta?' },
  restart: { label: 'Restartuj', icon: RotateCw, confirm: 'Zrestartować Minecrafta?' },
}
const messages = {
  pending: 'Crafty przetwarza żądanie. MCC sprawdza stan gry.',
  done: 'Zmiana stanu została potwierdzona przez Crafty.',
  rejected: 'Crafty lub MCC odrzuciło akcję. Sprawdź status gry oraz uprawnienia.',
  uncertain: 'Wynik nie został potwierdzony. Sprawdź stan w Crafty przed ponowieniem.',
  acknowledged: 'Operator zweryfikował poprzednią operację.',
}

export function PowerPanel({ csrf, running }: { csrf: string; running: boolean | null }) {
  const [state, setState] = useState<State | null>(null)
  const [selection, setSelection] = useState<{ action: Action; id: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const operation = state?.operation
  const pending = operation?.status === 'pending'
  const uncertain = operation?.status === 'uncertain'
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(endpoint)
      if (!response.ok) throw new Error('Power state unavailable')
      setState(await response.json() as State)
      setError('')
    } catch {
      setError('MCC nie może odczytać stanu operacji.')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [pending, refresh])
  useEffect(() => {
    if (selection && !dialog.current?.open) dialog.current?.showModal()
  }, [selection])

  async function send(value: { action: Action | 'acknowledge'; id: string }) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MCC-CSRF': csrf },
        body: JSON.stringify({ ...value, confirmed: true }),
      })
      if (response.ok || response.status === 409) {
        setState(await response.json() as State)
        dialog.current?.close()
      } else {
        setError(response.status === 503 ? 'Sterowanie Crafty jest niedostępne.' : 'MCC odrzuciło żądanie. Sprawdź stan i sesję.')
      }
    } catch {
      setError('Nie udało się odczytać odpowiedzi MCC. Sprawdź stan przed ponowieniem.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel">
    <PanelHeading title="Sterowanie serwerem" />
    {!state && !error && <p className="empty-state" role="status">Sprawdzanie dostępności sterowania…</p>}
    {state && !state.enabled && <p className="empty-state">Start, stop i restart są dostępne w Terminalu w Crafty.</p>}
    {state?.enabled && <>
      <div className="action-list">
        {(Object.entries(commands) as [Action, (typeof commands)[Action]][]).map(([action, { label, icon: Icon }]) => (
          <Button key={action} variant={action === 'stop' ? 'danger' : 'secondary'}
            disabled={busy || pending || uncertain || running === null || (action === 'start' ? running : !running)}
            onClick={() => { setError(''); setSelection({ action, id: crypto.randomUUID() }) }}>
            <Icon size={16} aria-hidden="true" />{label}
          </Button>
        ))}
      </div>
      {operation && <p className="empty-state" role="status">{messages[operation.status]}</p>}
      {uncertain && <Button loading={busy} onClick={() => void send({ action: 'acknowledge', id: operation.id })}>Stan w Crafty sprawdzony</Button>}
    </>}
    {!selection && error && <div className="power-feedback" role="alert"><Notice title={error} tone="error"><Button onClick={() => void refresh()}>Odśwież stan</Button></Notice></div>}
    <dialog ref={dialog} aria-labelledby="mcc-power-title" onClose={() => setSelection(null)} onCancel={(event) => { if (busy) event.preventDefault() }}>
      <form method="dialog">
        <h2 id="mcc-power-title">{selection ? commands[selection.action].confirm : ''}</h2>
        <p>{selection?.action === 'start' ? 'Crafty uruchomi proces Minecrafta.' : 'Gracze zostaną rozłączeni podczas operacji.'}</p>
        {selection && error && <div className="power-feedback" role="alert"><Notice title={error} tone="error" /></div>}
        <div className="dialog-actions">
          <Button type="submit" disabled={busy} autoFocus>Anuluj</Button>
          <Button variant={selection?.action === 'stop' ? 'danger' : 'primary'} loading={busy} onClick={() => { if (selection) void send(selection) }}>
            {selection ? commands[selection.action].label : ''}
          </Button>
        </div>
      </form>
    </dialog>
  </section>
}
