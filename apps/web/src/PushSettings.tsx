import { useEffect, useId, useState } from 'react'
import { Button, PanelHeading } from './ui'
import type { Account } from './SessionGate'

type Settings = { enabled: false } | { enabled: true; publicKey: string; deviceIds: string[] }
type Action = 'enable' | 'disable' | 'test' | 'clear'
const endpoint = '/api/mcc/notifications'

async function deviceId(subscription: PushSubscription) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function appKey(value: string) {
  const encoded = value.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), (character) => character.charCodeAt(0))
}

export function PushSettings({ account, verifySession }: { account: Account; verifySession: () => Promise<void> }) {
  const title = useId()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [manager, setManager] = useState<PushManager | null>(null)
  const [device, setDevice] = useState<{ subscription: PushSubscription; id: string } | null>(null)
  const [busy, setBusy] = useState<Action | null>(null)
  const [message, setMessage] = useState('')
  const [denied, setDenied] = useState(false)
  const installed = window.matchMedia('(display-mode: standalone)').matches
    || ('standalone' in navigator && navigator.standalone === true)
  const supported = installed && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window

  useEffect(() => {
    if (document.documentElement.dataset.mccPrivate !== 'true') return
    const request = new AbortController()
    async function prepare() {
      try {
        const result = await fetch(endpoint, { signal: request.signal })
        if (result.status === 401) void verifySession()
        if (!result.ok) throw new Error('Powiadomienia niedostępne')
        const settings: Settings = await result.json()
        if (request.signal.aborted) return
        setSettings(settings)
        if (!settings.enabled || !supported) return
        setDenied('Notification' in window && Notification.permission === 'denied')
        await navigator.serviceWorker.register('/push-worker.js')
        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.getSubscription()
        const current = subscription ? { subscription, id: await deviceId(subscription) } : null
        if (request.signal.aborted) return
        setDevice(current)
        setManager(registration.pushManager)
      } catch {
        if (!request.signal.aborted) setMessage('Nie udało się przygotować powiadomień. Odśwież MCC i spróbuj ponownie.')
      }
    }
    void prepare()
    return () => request.abort()
  }, [account.csrf, supported, verifySession])

  const active = Boolean(settings?.enabled && device && settings.deviceIds.includes(device.id))
  async function run(action: Action) {
    if (!settings?.enabled || busy) return
    setBusy(action)
    setMessage('')
    try {
      let current = device
      if (action === 'enable' && !current && manager) {
        const subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey(settings.publicKey) })
        current = { subscription, id: await deviceId(subscription) }
        setDevice(current)
      }
      const body = action === 'enable' ? { action, subscription: current?.subscription.toJSON() } : { action, id: current?.id }
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCC-CSRF': account.csrf },
        body: JSON.stringify(body) })
      if (response.status === 401) {
        void verifySession()
        throw new Error('Sesja MCC wygasła. Zaloguj się ponownie.')
      }
      if (response.status === 410 && current) {
        await current.subscription.unsubscribe().catch(() => {})
        setDevice(null)
        setSettings(await response.json())
        throw new Error('Zapis urządzenia wygasł. Włącz powiadomienia ponownie.')
      }
      if (response.status === 429) throw new Error(action === 'test' ? 'Odczekaj minutę przed kolejną próbą.' : 'Osiągnięto limit urządzeń. Wyłącz wcześniejsze zapisy przed ponowną próbą.')
      if (response.status === 409) throw new Error('To urządzenie jest zarejestrowane na innym koncie MCC.')
      if (response.status === 400 && action === 'enable') throw new Error('Ten panel obsługuje usługę powiadomień Apple.')
      if (!response.ok) throw new Error(action === 'test' ? 'Usługa push nie przyjęła powiadomienia próbnego.' : 'Nie udało się zapisać ustawień powiadomień.')
      setSettings(await response.json())
      if (action === 'disable' || (action === 'clear' && active)) {
        if (await current?.subscription.unsubscribe().catch(() => false)) setDevice(null)
      }
      if (action === 'test') setMessage('Usługa push przyjęła próbę. Sprawdź powiadomienia na urządzeniu.')
    } catch (error) {
      const rejected = 'Notification' in window && Notification.permission === 'denied'
      setDenied(rejected)
      setMessage(rejected && action === 'enable' ? 'Zezwól na powiadomienia MCC w ustawieniach iPhone’a.'
        : error instanceof DOMException ? 'Urządzenie nie przyznało zgody na powiadomienia.'
        : error instanceof Error ? error.message : 'Nie udało się zmienić ustawień powiadomień.')
    } finally {
      setBusy(null)
    }
  }

  if (!settings?.enabled && !message) return null
  return <section className="panel push-settings" aria-labelledby={title}>
    <PanelHeading id={title} title="Powiadomienia na iPhonie"
      description="Potwierdzony start i zatrzymanie serwera Minecraft." />
    {settings?.enabled && <>
      {!installed && <p>Dodaj MCC do ekranu początkowego i otwórz je z ikony, aby włączyć powiadomienia.</p>}
      {installed && !supported && <p>Ta wersja przeglądarki nie udostępnia powiadomień MCC.</p>}
      {supported && denied && <p>Zezwól na powiadomienia MCC w ustawieniach urządzenia, a potem otwórz panel ponownie.</p>}
      {supported && !manager && !denied && !message && <p role="status">Przygotowywanie powiadomień…</p>}
      <div className="action-list">
        {manager && (active ? <>
          <Button onClick={() => void run('test')} disabled={busy !== null || denied} loading={busy === 'test'}>Wyślij powiadomienie próbne</Button>
          <Button onClick={() => void run('disable')} disabled={busy !== null} loading={busy === 'disable'}>Wyłącz na tym urządzeniu</Button>
        </> : <Button variant="primary" onClick={() => void run('enable')} disabled={busy !== null || denied} loading={busy === 'enable'}>Włącz na tym urządzeniu</Button>)}
        {settings.deviceIds.length > (active ? 1 : 0) && <Button onClick={() => void run('clear')} disabled={busy !== null} loading={busy === 'clear'}>Wyłącz na wszystkich urządzeniach</Button>}
      </div>
    </>}
    {message && <p role="status">{message}</p>}
  </section>
}
