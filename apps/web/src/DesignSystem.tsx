import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, Notice, PanelHeading, ServerStatus } from './ui'

const colors = [
  { token: '--bg', name: 'Tło' },
  { token: '--panel', name: 'Powierzchnia' },
  { token: '--text', name: 'Tekst' },
  { token: '--muted', name: 'Tekst pomocniczy' },
  { token: '--accent', name: 'Akcent' },
  { token: '--violet', name: 'RAM' },
  { token: '--gold', name: 'Ostrzeżenie' },
  { token: '--danger', name: 'Błąd' },
] as const

type Readout = 'idle' | 'loading' | 'error' | 'success'

export default function DesignSystem() {
  const [readout, setReadout] = useState<Readout>('idle')
  const [nickname, setNickname] = useState('')
  const [touched, setTouched] = useState(false)
  const timeout = useRef<number | null>(null)
  const loading = readout === 'loading'
  const invalid = touched && !/^[A-Za-z0-9_]{3,16}$/.test(nickname)

  useEffect(() => () => {
    if (timeout.current !== null) window.clearTimeout(timeout.current)
  }, [])

  function simulate(result: 'error' | 'success') {
    if (timeout.current !== null) return
    setReadout('loading')
    timeout.current = window.setTimeout(() => {
      timeout.current = null
      setReadout(result)
    }, 900)
  }

  return (
    <>
      <div className="view-header"><p>Obserwatorium</p><h1>System projektowy</h1></div>
      <div className="design-grid">
        <section className="panel">
          <PanelHeading title="Kolory" description="Paleta Obserwatorium" />
          <ul className="swatches">
            {colors.map(({ token, name }) => <li key={token}><span className="swatch" style={{ backgroundColor: 'var(' + token + ')' }} aria-hidden="true" /><div><strong>{name}</strong><code>{token}</code></div></li>)}
          </ul>
        </section>
        <section className="panel">
          <PanelHeading title="Typografia i odstępy" />
          <div className="type-samples">
            <p className="sample-heading">Northstar Survival <small>Space Grotesk · nagłówki</small></p>
            <p className="sample-body">Ostatnia aktywność serwera <small>Inter · interfejs</small></p>
            <p className="sample-mono">14:28:31 [INFO] <small>Monospace · dane techniczne</small></p>
          </div>
          <div className="space-samples" aria-label="Skala odstępów w pikselach">
            {[1, 2, 3, 4, 5, 6, 8].map((step) => <span key={step}><i aria-hidden="true" style={{ width: 'var(--space-' + step + ')' }} />{step * 4}</span>)}
          </div>
        </section>
        <section className="panel">
          <PanelHeading title="Stany operacji" description="Symulowany odczyt statystyk" />
          <div className="design-actions">
            <Button variant="primary" loading={loading} onClick={() => simulate('success')}>
              {!loading && <RefreshCw size={16} aria-hidden="true" />}
              {loading ? 'Pobieranie…' : readout === 'error' ? 'Ponów próbę' : 'Sprawdź odczyt'}
            </Button>
            <Button disabled={loading} onClick={() => simulate('error')}>Symuluj błąd</Button>
            <Button disabled>Pobierz raport</Button>
          </div>
          <div className="readout" role="status" aria-live="polite" aria-atomic="true">
            {readout === 'loading' && <><span className="visually-hidden">Pobieranie danych demo.</span><div className="skeleton" aria-hidden="true"><span /><span /></div></>}
            {readout === 'idle' && <Notice title="Brak danych">Uruchom przykładowy odczyt.</Notice>}
            {readout === 'error' && <Notice title="Nie udało się pobrać danych" tone="error">Upłynął limit czasu w symulacji. Możesz ponowić próbę.</Notice>}
            {readout === 'success' && <Notice title="Odczyt gotowy" tone="success">CPU 37% · RAM 4,6 GB</Notice>}
          </div>
        </section>
        <section className="panel">
          <PanelHeading title="Pola i status" description="Pole sprawdza nazwę po opuszczeniu go klawiszem Tab lub kliknięciem." />
          <div className="design-field">
            <label htmlFor="sample-nick">Nazwa gracza</label>
            <input id="sample-nick" value={nickname} onChange={(event) => setNickname(event.target.value)} onBlur={() => setTouched(true)} autoComplete="off" autoCapitalize="none" aria-invalid={invalid || undefined} aria-describedby="sample-nick-hint" placeholder="np. Mosswalker" />
            <p id="sample-nick-hint" role="status">{invalid ? 'Wpisz od 3 do 16 liter A–Z, cyfr lub znaków _.' : '3–16 znaków, np. Astra_01.'}</p>
          </div>
          <div className="design-actions"><ServerStatus online /><ServerStatus online={false} /></div>
        </section>
      </div>
    </>
  )
}
