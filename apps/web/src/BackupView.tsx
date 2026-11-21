import { useEffect, useState } from 'react'
import { Download, HardDrive, RefreshCw } from 'lucide-react'
import { Button, Notice, PanelHeading } from './ui'

type Backup = {
  id: string
  sourceDate: string
  verifiedAt: string
  size: number
  files: number
  encryptedSha256: string
  format?: 'tar.age' | 'zip.age'
}

const snapshotDate = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'long', timeZone: 'UTC' })
const verifiedDate = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' })
const number = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 })
const showSize = (bytes: number) => bytes >= 2 ** 30
  ? number.format(bytes / 2 ** 30) + ' GiB' : number.format(bytes / 2 ** 20) + ' MiB'

export default function BackupView({ verifySession }: { verifySession: () => Promise<void> }) {
  const [backups, setBackups] = useState<Backup[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setFailed(false)
      try {
        const response = await fetch('/api/mcc/backups', { signal: controller.signal })
        if (response.status === 401) await verifySession()
        if (!response.ok) throw new Error('Backup listing unavailable')
        const data: { backups: Backup[] } = await response.json()
        setBackups(data.backups)
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [reload, verifySession])

  return <section className="panel backup-panel" aria-label="Kopie poza Oracle">
    <PanelHeading title="Kopie poza Oracle">
      <Button onClick={() => setReload((value) => value + 1)} loading={loading}>
        <RefreshCw size={15} aria-hidden="true" /> Odśwież
      </Button>
    </PanelHeading>
    {failed && <div role="alert"><Notice title="Historia kopii jest chwilowo niedostępna" tone="error" /></div>}
    {!backups && loading && <p className="empty-state" role="status">Wczytywanie kopii…</p>}
    {backups?.length === 0 && !failed && <p className="empty-state">Brak zweryfikowanych kopii na tym komputerze.</p>}
    {!!backups?.length && <ul className="waypoint-list backup-list">
      {backups.map((backup) => <li key={backup.id}>
        <span className="event-icon"><HardDrive size={17} aria-hidden="true" /></span>
        <div>
          <strong>{backup.format === 'zip.age' ? 'Kopia Crafty z ' : 'Kopia migracyjna z '}{snapshotDate.format(new Date(backup.sourceDate))}
            {backup.format === 'zip.age' && ' · ' + backup.id.split('_')[1]?.replaceAll('-', ':')}</strong>
          <p>{showSize(backup.size)} · {number.format(backup.files)} plików · {backup.format ?? 'tar.age'}</p>
          <p>Sprawdzono <time dateTime={backup.verifiedAt}>{verifiedDate.format(new Date(backup.verifiedAt))}</time></p>
          <details className="backup-details"><summary>Suma kontrolna SHA-256</summary><code>{backup.encryptedSha256}</code></details>
        </div>
        <div className="world-map-actions"><a className="button primary" href={'/api/mcc/backups/' + backup.id} download>
          <Download size={16} aria-hidden="true" /> Pobierz zaszyfrowaną kopię
        </a></div>
      </li>)}
    </ul>}
  </section>
}
