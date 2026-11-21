import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Copy, Search, Terminal } from 'lucide-react'
import { demoOnlinePlayers, dimensions, players } from './demo'
import type { Level, Log } from './demo'
import { Button, IconButton, PanelHeading, ServerStatus } from './ui'

const levels = ['Wszystkie', 'INFO', 'WARN', 'ERROR', 'Inne'] as const

function logText(log: Log) {
  return [log.original ?? `${log.time} [${log.level}] ${log.message}`, ...(log.trace ?? [])].join('\n')
}

export function ConsoleView({ logs, online = false, pending = false, commands = [], onCommand, onList, compact = false, emptyText, live = false }: {
  logs: Log[]
  online?: boolean
  pending?: boolean
  commands?: string[]
  onCommand?: (command: string) => void
  onList?: () => void
  compact?: boolean
  emptyText?: string
  live?: boolean
}) {
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<(typeof levels)[number]>('Wszystkie')
  const [follow, setFollow] = useState(true)
  const [command, setCommand] = useState('')
  const [feedback, setFeedback] = useState('')
  const [copyFallback, setCopyFallback] = useState<string | null>(null)
  const copyInput = useRef<HTMLTextAreaElement>(null)
  const copyTrigger = useRef<HTMLButtonElement>(null)
  const historyIndex = useRef<number | null>(null)
  const draft = useRef('')
  const commandInput = useRef<HTMLInputElement>(null)
  const canSend = online && !pending
  const viewport = useRef<HTMLDivElement>(null)
  const term = query.trim().toLocaleLowerCase()
  const visible = (compact ? logs.slice(-6) : logs).filter((log) => (
    (level === 'Wszystkie' || level === log.level) && (!term || logText(log).toLocaleLowerCase().includes(term))
  ))
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [follow, logs, level, query])
  useEffect(() => {
    const input = copyInput.current
    if (copyFallback === null || !input) return
    input.focus({ preventScroll: true })
    input.select()
    input.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [copyFallback])

  async function copyLogs(text: string, trigger: HTMLButtonElement, oneEntry = false) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyFallback(null)
      setFeedback(oneEntry ? 'Skopiowano wpis.' : 'Skopiowano widoczne logi.')
    } catch {
      copyTrigger.current = trigger
      setCopyFallback(text)
      setFeedback('Schowek jest niedostępny. Skopiuj tekst z pola poniżej.')
    }
  }

  return (
    <section className={'panel console-panel' + (compact ? ' compact' : '')} aria-label={live ? 'Konsola Minecrafta' : onCommand ? 'Konsola demonstracyjna' : 'Logi serwera z Crafty'}>
      <PanelHeading title={compact ? 'Ostatnie wpisy konsoli' : 'Konsola serwera'} description={compact ? 'Podgląd demonstracyjny'
        : onCommand ? live ? 'Komendy Minecrafta · ↑ / ↓ przewijają historię' : 'Komendy demo: list, say i help · ↑ / ↓ przewijają historię'
          : onList ? 'Logi i lista graczy z Crafty' : 'Najnowsze wpisy z pliku logów · tylko odczyt'}>
        <IconButton aria-label="Kopiuj widoczne logi" title="Kopiuj widoczne logi" disabled={!visible.length}
          onClick={(event) => void copyLogs(visible.map(logText).join('\n'), event.currentTarget)}><Copy size={16} aria-hidden="true" /></IconButton>
      </PanelHeading>
      {!compact && (
        <div className="console-tools">
          <label className="search"><Search size={16} /><input aria-label="Szukaj w logach" placeholder="Szukaj w logach" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <select aria-label="Poziom logów" value={level} onChange={(e) => setLevel(e.target.value as Level | 'Wszystkie')}>{levels.filter((option) => live || !onCommand || option !== 'Inne').map((option) => <option key={option}>{option}</option>)}</select>
          <label className="follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Automatyczne przewijanie</label>
          {onList && <Button onClick={onList} disabled={!canSend}>Pobierz listę graczy</Button>}
          {onCommand && <select className="command-history" aria-label="Historia komend" value="" disabled={!canSend || !commands.length} onChange={(event) => {
            if (!event.target.value) return
            historyIndex.current = null
            setCommand(commands[Number(event.target.value)])
            commandInput.current?.focus()
          }}>
            <option value="">Historia komend</option>
            {commands.map((value, index) => <option value={index} key={index}>{value}</option>).reverse()}
          </select>}
        </div>
      )}
      <div className="terminal" ref={viewport} tabIndex={0} aria-label="Lista wpisów konsoli">
        {!visible.length && <p>{logs.length ? 'Brak wpisów pasujących do filtra.' : emptyText ?? 'Brak wpisów.'}</p>}
        {visible.map((log) => <div className="log" key={log.id}>
          <time>{log.time}</time><strong className={log.level}>{log.level}</strong>
          <div>
            <span>{log.message}</span>
            {log.trace && <pre className="log-trace">{log.trace.join('\n')}</pre>}
            {!compact && (log.trace || log.level === 'ERROR') && <div className="log-copy">
              <Button aria-label={'Kopiuj wpis z godziny ' + log.time} onClick={(event) => void copyLogs(logText(log), event.currentTarget, true)}>
                <Copy size={14} aria-hidden="true" /> Kopiuj wpis
              </Button>
            </div>}
          </div>
        </div>)}
      </div>
      {!compact && onCommand && (
        <form className="command-bar" onSubmit={(e) => {
          e.preventDefault()
          const value = command.trim()
          if (!canSend || !value) return
          onCommand(value)
          historyIndex.current = null
          draft.current = ''
          setCommand('')
          setFeedback(live ? '' : 'Dodano komendę i jej wynik do logów demo.')
        }}>
          <Terminal size={17} />
          <input ref={commandInput} aria-label={live ? 'Komenda Minecrafta' : 'Komenda demonstracyjna'} maxLength={160}
            placeholder={pending ? 'Trwa operacja serwera' : online ? live ? 'Przykład: list' : 'Wpisz komendę demo, np. list'
              : live ? 'Brak aktywnego procesu gry' : 'Serwer demo jest offline'} disabled={!canSend} value={command} onChange={(e) => {
            historyIndex.current = null
            setCommand(e.target.value)
          }} onKeyDown={(e) => {
            if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !commands.length || e.nativeEvent.isComposing) return
            e.preventDefault()
            if (historyIndex.current === null) draft.current = command
            const index = (historyIndex.current ?? commands.length) + (e.key === 'ArrowUp' ? -1 : 1)
            if (index >= commands.length) {
              historyIndex.current = null
              setCommand(draft.current)
              return
            }
            historyIndex.current = Math.max(0, index)
            setCommand(commands[historyIndex.current])
          }} />
          <Button variant="primary" disabled={!canSend || !command.trim()} type="submit">{live ? 'Sprawdź komendę' : 'Symuluj'} <ArrowUpRight size={15} /></Button>
        </form>
      )}
      {live && onCommand && <details className="command-help"><summary>Obsługiwane komendy</summary>
        <p><code>list</code>, <code>say</code>, <code>weather</code>, <code>time set</code>, <code>save-all</code>, <code>gamerule</code>, <code>whitelist</code>, <code>kick</code>, <code>ban</code>, <code>pardon</code>, <code>op</code> i <code>deop</code>.</p>
      </details>}
      <p className={feedback ? 'console-feedback' : 'visually-hidden'} role="status">{feedback}</p>
      {copyFallback !== null && <div className="console-copy-text">
        <label>Tekst do skopiowania<textarea ref={copyInput} value={copyFallback} readOnly rows={5} /></label>
        <Button onClick={() => {
          setCopyFallback(null)
          setFeedback('')
          const trigger = copyTrigger.current
          if (trigger?.isConnected) trigger.focus()
          else viewport.current?.focus()
        }}>Zamknij podgląd tekstu</Button>
      </div>}
    </section>
  )
}

export function PlayersView({ online }: { online: boolean }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const results = players.filter((player) => {
    const available = online && player.online
    return player.name.toLowerCase().includes(query.trim().toLowerCase())
      && (filter === 'all' || available === (filter === 'online'))
  })
  return (
    <section className="panel players-panel" aria-label="Lista graczy demo">
      <PanelHeading title="Lista graczy" description={(online ? demoOnlinePlayers.length : 0) + ' online · ' + players.length + ' w bazie demo'} />
      <div className="console-tools">
        <label className="search"><Search size={16} /><input aria-label="Szukaj gracza" placeholder="Szukaj gracza" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <select value={filter} aria-label="Stan gracza" onChange={(e) => setFilter(e.target.value)}>
          <option value="all">Wszyscy</option><option value="online">Online</option><option value="offline">Offline</option>
        </select>
      </div>
      <ul className="players-list">
        {results.map((player) => {
          const available = online && player.online
          return (
            <li key={player.name}>
              <span className="avatar" style={{ color: player.color }}>{player.initials}</span>
              <div><strong>{player.name}</strong><span>{player.role}</span></div>
              <span className="player-dimension">{available && player.dimension ? dimensions[player.dimension] : '—'}</span>
              <ServerStatus online={available} />
            </li>
          )
        })}
      </ul>
      {!results.length && <p className="empty-state">Brak graczy pasujących do filtra.</p>}
    </section>
  )
}
