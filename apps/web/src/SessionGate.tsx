import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { LockKeyhole } from 'lucide-react'
import { Brand, Button, Notice } from './ui'

export type Account = { username: string; role: 'viewer' | 'operator'; csrf: string }

type SessionActions = {
  refresh: () => Promise<void>
  signOut: () => Promise<void>
  signingOut: boolean
  signOutError: string
}

const sessionUrl = '/api/mcc/session'
const loginErrors: Record<number, string> = {
  401: 'Niepoprawna nazwa użytkownika lub hasło.',
  429: 'Zbyt wiele prób. Odczekaj minutę i spróbuj ponownie.',
  503: 'MCC nie może sprawdzić konta. Sprawdź konfigurację lokalnego backendu.',
}

function LoginForm({ onLogin }: { onLogin: (account: Account) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const fields = new FormData(event.currentTarget)
    setError('')
    setBusy(true)
    try {
      const response = await fetch(sessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fields.get('username'), password: fields.get('password') }),
      })
      if (!response.ok) {
        setError(loginErrors[response.status] ?? 'Nie udało się zalogować.')
        return
      }
      const result = await response.json() as { account: Account }
      onLogin(result.account)
    } catch {
      setError('Brak połączenia z lokalnym backendem MCC.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel login-form" onSubmit={(event) => void submit(event)}>
      <h1>Zaloguj się do MCC</h1>
      <p>Użyj konta MCC, aby otworzyć dane serwera.</p>
      <div className="design-field">
        <label htmlFor="mcc-username">Nazwa użytkownika</label>
        <input id="mcc-username" name="username" autoComplete="username" autoCapitalize="none" maxLength={32} required />
      </div>
      <div className="design-field">
        <label htmlFor="mcc-password">Hasło</label>
        <input id="mcc-password" name="password" type="password" autoComplete="current-password" maxLength={256} required />
      </div>
      {error && <div role="alert"><Notice title={error} tone="error" /></div>}
      <Button type="submit" variant="primary" loading={busy}>
        {!busy && <LockKeyhole size={16} aria-hidden="true" />}{busy ? 'Logowanie…' : 'Zaloguj się'}
      </Button>
    </form>
  )
}

export function SessionGate({ children }: { children: (account: Account, actions: SessionActions) => ReactNode }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const at = generation.current
    try {
      const response = await fetch(sessionUrl, { cache: 'no-store' })
      if (!response.ok) throw new Error('Session unavailable')
      const result = await response.json() as { account: Account | null }
      if (at !== generation.current) return
      setAccount((current) => current?.csrf === result.account?.csrf && current !== undefined ? current : result.account)
      setFailed(false)
    } catch {
      if (at === generation.current) setFailed(true)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function signOut() {
    if (!account || signingOut) return
    setSigningOut(true)
    setSignOutError('')
    try {
      const response = await fetch(sessionUrl, { method: 'DELETE', headers: { 'X-MCC-CSRF': account.csrf } })
      if (!response.ok) throw new Error('Logout failed')
      generation.current++
      setAccount(null)
    } catch {
      setSignOutError('Nie udało się wylogować. Spróbuj ponownie.')
    } finally {
      setSigningOut(false)
    }
  }

  if (account) return children(account, { refresh, signOut, signingOut, signOutError })

  return (
    <div className="app observatory login-page">
      <header className="login-header"><Brand /><a className="design-link" href="?mode=demo#observatory/overview">Tryb demo</a></header>
      <main className="login-layout">
        <section className="login-card" aria-label="Dostęp do MCC">
          {failed
            ? <div className="panel login-form" role="status">
              <Notice title="Brak połączenia z MCC" tone="error">Sprawdź, czy działa lokalne API.</Notice>
              <Button onClick={() => void refresh()}>Ponów próbę</Button>
            </div>
            : account === undefined
              ? <div role="status"><Notice title="Sprawdzanie sesji MCC" /></div>
              : <LoginForm onLogin={(next) => { generation.current++; setAccount(next) }} />}
        </section>
      </main>
    </div>
  )
}
