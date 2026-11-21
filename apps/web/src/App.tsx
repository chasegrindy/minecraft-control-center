import { useEffect, useRef, useState } from 'react'
import { Activity, Box, ChevronRight, CircleHelp, Compass, LayoutDashboard, PanelsTopLeft, Terminal, Users } from 'lucide-react'
import { ActivityPanel, BackupNote, Hero, MetricCards, Performance, QuickActions, WorldMap } from './Dashboard'
import DesignSystem from './DesignSystem'
import { ConsoleView, PlayersView } from './Views'
import { Brand, Button, ServerStatus } from './ui'
import { actions, concepts } from './demo'
import type { Concept, ServerAction, View } from './demo'
import { useDemoServer } from './demo-state'

const navigation = {
  overview: { name: 'Przegląd', icon: LayoutDashboard },
  console: { name: 'Konsola', icon: Terminal },
  players: { name: 'Gracze', icon: Users },
  world: { name: 'Mapa świata', icon: Compass },
  activity: { name: 'Aktywność', icon: Activity },
} as const

const conceptKeys = Object.keys(concepts) as Concept[]
const viewKeys = Object.keys(navigation) as (keyof typeof navigation)[]

function readLocation() {
  const [concept, view] = window.location.hash.slice(1).split('/')
  return {
    concept: view !== 'design' && conceptKeys.includes(concept as Concept) ? concept as Concept : 'observatory' as const,
    view: view === 'design' || viewKeys.includes(view as keyof typeof navigation) ? view as View : 'overview' as const,
  }
}

export default function App() {
  const [{ concept, view }, setLocation] = useState(readLocation)
  const server = useDemoServer()
  const { online, pending, logs, events, sample, status } = server
  const [action, setAction] = useState<ServerAction | null>(null)
  const [notice, setNotice] = useState('')
  const [showAbout, setShowAbout] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const aboutDialog = useRef<HTMLDialogElement>(null)
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    function onHashChange() { setLocation(readLocation()) }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (action) dialog.current?.showModal()
  }, [action])

  useEffect(() => {
    if (showAbout) aboutDialog.current?.showModal()
  }, [showAbout])

  useEffect(() => {
    if (!status) return
    setNotice(status)
    const timeout = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timeout)
  }, [status])

  function go(nextConcept: Concept, nextView: View) {
    window.location.hash = nextConcept + '/' + nextView
    setLocation({ concept: nextConcept, view: nextView })
    if (nextView !== view) {
      main.current?.focus({ preventScroll: true })
      window.scrollTo(0, 0)
    }
  }

  function navigate(next: View) {
    go(concept, next)
  }

  function executeAction() {
    if (!action) return
    server.request(action)
    dialog.current?.close()
  }

  const navLinks = viewKeys.map((key) => {
    const { icon: Icon, name } = navigation[key]
    return <a key={key} href={'#' + concept + '/' + key} aria-current={view === key ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(key) }}><Icon size={18} /><span>{name}</span></a>
  })
  const metrics = <MetricCards sample={sample} startedAt={server.startedAt} />
  const performance = <Performance sample={sample} samples={server.samples} online={online} paused={server.paused} togglePause={() => server.setPaused((value) => !value)} />
  const activity = <ActivityPanel events={events} navigate={navigate} />
  const controls = <QuickActions online={online} pending={pending} requestAction={setAction} navigate={navigate} />
  const consoleProps = { logs, online, pending: pending !== null, commands: server.commands, onCommand: server.sendCommand }
  const viewName = view === 'design' ? 'System projektowy' : navigation[view].name

  return (
    <div className={'app ' + concept}>
      <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); main.current?.focus() }}>Przejdź do treści</a>
      <aside className="sidebar">
        <a className="brand-link" href={'#' + concept + '/overview'} aria-label="MCC — przegląd" onClick={(e) => { e.preventDefault(); navigate('overview') }}><Brand /></a>
        {concept !== 'operator' && <div className="server-selector"><Box size={17} /><div><strong>Northstar Survival</strong><span>Java Edition</span></div><span className={'server-light ' + (online ? 'on' : '')} /></div>}
        <nav className="navigation" aria-label="Główna nawigacja">{navLinks}</nav>
        <button className="sidebar-help" onClick={() => setShowAbout(true)}><CircleHelp size={18} /><span>O prototypie</span></button>
      </aside>
      <div className="shell">
        <header className="topbar">
          <div className="breadcrumb"><span>MCC</span><ChevronRight size={14} /><strong>{viewName}</strong></div>
          <div className="topbar-tools">
            <span className="demo-badge"><span /> Dane demo</span>
            {import.meta.env.VITE_MCC_LIVE === 'true' && <a className="design-link" href="?mode=live#observatory/overview">Dane z Crafty</a>}
            <a className="design-link" href="#observatory/design" aria-current={view === 'design' ? 'page' : undefined} onClick={(event) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              go('observatory', 'design')
            }}><PanelsTopLeft size={16} aria-hidden="true" /> System projektowy</a>
          </div>
        </header>
        <main ref={main} id="main-content" tabIndex={-1} className="content">
          {view === 'overview' && concept === 'observatory' && <>
            <Hero online={online} pending={pending} navigate={navigate} requestAction={setAction} />
            {metrics}
            <div className="main-grid">{performance}{activity}</div>
            {controls}
          </>}
          {view === 'overview' && concept === 'operator' && <>
            <div className="operator-header"><div><p>Serwer / Java Edition 1.21.11</p><h1>Northstar Survival</h1></div><div><ServerStatus online={online} /><BackupNote time={events.find((event) => event.kind === 'backup')?.time} /></div></div>
            {metrics}
            <div className="operator-grid"><ConsoleView {...consoleProps} compact /><div>{controls}{activity}</div></div>
            {performance}
          </>}
          {view === 'overview' && concept === 'atlas' && <>
            <div className="atlas-header"><div><p>Świat survival · Java Edition 1.21.11</p><h1>Northstar Survival</h1></div><ServerStatus online={online} /></div>
            <div className="atlas-grid"><WorldMap online={online} /><div>{activity}{controls}</div></div>
            {metrics}
            {performance}
          </>}
          {view !== 'overview' && view !== 'design' && <div className="view-header"><p>Northstar Survival</p><h1>{viewName}</h1></div>}
          {view === 'design' && <DesignSystem />}
          {view === 'activity' && <ActivityPanel events={events} />}
          {view === 'console' && <ConsoleView {...consoleProps} />}
          {view === 'players' && <PlayersView online={online} />}
          {view === 'world' && <WorldMap online={online} />}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Nawigacja mobilna">{navLinks}</nav>
      <div className={notice ? 'toast' : 'visually-hidden'} role="status">{notice}</div>
      <dialog ref={dialog} aria-labelledby="action-title" onClose={() => setAction(null)}>
        <form method="dialog">
          <h2 id="action-title">{action ? actions[action].confirm : ''}</h2>
          <p>Zmieni się stan fikcyjnego serwera Northstar Survival w prototypie.</p>
          <div className="dialog-actions">
            <Button type="submit" autoFocus>Anuluj</Button>
            <Button variant={action === 'stop' ? 'danger' : 'primary'} onClick={executeAction}>{action ? actions[action].label : ''}</Button>
          </div>
        </form>
      </dialog>
      <dialog ref={aboutDialog} aria-labelledby="about-title" onClose={() => setShowAbout(false)}>
        <form method="dialog">
          <h2 id="about-title">Koncepcje dashboardu</h2>
          <p>Obserwatorium to wybrany kierunek MCC. Tu możesz wrócić do koncepcji z fazy 1.</p>
          <dl className="concept-details">{conceptKeys.map((key) => <div key={key}><dt><a href={'#' + key + '/overview'} onClick={(event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            aboutDialog.current?.close()
            go(key, 'overview')
          }}>{concepts[key].name}</a></dt><dd>{concepts[key].detail}</dd></div>)}</dl>
          <div className="dialog-actions"><Button type="submit" variant="primary" autoFocus>Zamknij</Button></div>
        </form>
      </dialog>
    </div>
  )
}
