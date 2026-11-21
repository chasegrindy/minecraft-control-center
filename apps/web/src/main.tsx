import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/space-grotesk'
import App from './App'
import LiveApp from './LiveApp'
import './tokens.css'
import './styles.css'

const requestedMode = new URLSearchParams(window.location.search).get('mode')
const [concept, view] = window.location.hash.slice(1).split('/')
const demoRoute = concept === 'operator' || concept === 'atlas' || view === 'design' || view === 'world' || view === 'activity'
const privateSite = document.documentElement.dataset.mccPrivate === 'true'
const live = requestedMode === 'live' || (requestedMode !== 'demo' && (privateSite || (!demoRoute && import.meta.env.VITE_MCC_LIVE === 'true')))
createRoot(document.getElementById('root')!).render(<StrictMode>{live ? <LiveApp /> : <App />}</StrictMode>)
