import { useEffect, useId, useMemo, useState } from 'react'
import { formatTime } from './demo'
import { PanelHeading, SegmentedControl } from './ui'

const ranges = { '1 h': 1, '6 h': 6, '24 h': 24 } as const
const options = Object.keys(ranges) as (keyof typeof ranges)[]
const hour = 3_600_000
const minute = 60_000
const dateTime = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
type Range = keyof typeof ranges
type Sample = { time: number; cpu: number | null; ram: number | null }
type History = { at: number; samples: Sample[]; partial: boolean }
type Result = { range: Range; history: History | null; failed: boolean }

function plot(samples: Sample[], metric: 'cpu' | 'ram', start: number, duration: number) {
  return samples.map((sample, index) => {
    const value = sample[metric]
    if (value === null) return ''
    const previous = samples[index - 1]
    const next = samples[index + 1]
    const x = (sample.time - start) / duration * 600
    const y = (100 - Math.min(100, value)).toFixed(2)
    const point = x.toFixed(2) + ',' + y
    if (previous && previous[metric] !== null && sample.time - previous.time === minute) return 'L' + point
    if (next && next[metric] !== null && next.time - sample.time === minute) return 'M' + point
    return 'M' + point + 'h.1'
  }).join(' ')
}

export function MetricHistory({ sampleMinute, verifySession }: { sampleMinute: number | null; verifySession: () => Promise<void> }) {
  const id = useId()
  const [range, setRange] = useState<Range>('1 h')
  const [result, setResult] = useState<Result | null>(null)
  const current = result?.range === range ? result : null
  const history = current?.history ?? null
  const duration = ranges[range] * hour
  const start = history ? history.at - duration : 0

  useEffect(() => {
    const request = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/mcc/history/' + ranges[range], { signal: request.signal })
        if (response.status === 401) void verifySession()
        if (!response.ok) throw new Error('Historia niedostępna')
        const history: History = await response.json()
        if (!request.signal.aborted) setResult({ range, history, failed: false })
      } catch {
        if (!request.signal.aborted) setResult((previous) => ({ range, failed: true,
          history: previous?.range === range ? previous.history : null }))
      }
    }
    void load()
    return () => request.abort()
  }, [range, sampleMinute, verifySession])

  const paths = useMemo(() => history ? { cpu: plot(history.samples, 'cpu', start, duration),
    ram: plot(history.samples, 'ram', start, duration) } : null, [history, start, duration])

  return <section className="panel performance metric-history" aria-labelledby={id}>
    <PanelHeading title="Obciążenie serwera" id={id} description="Zapis CPU i RAM · do jednej próbki na minutę">
      <SegmentedControl label="Zakres obciążenia" options={options} value={range} onChange={setRange} />
    </PanelHeading>
    {current?.failed && <p className="empty-state" role="status">Nie udało się odświeżyć historii obciążenia.</p>}
    {history?.partial && <p className="empty-state" role="status">Część zapisów historii jest niedostępna.</p>}
    {!current && <p className="empty-state" role="status">Odczyt historii obciążenia…</p>}
    {history && !history.samples.length && <p className="empty-state">Brak pomiarów w wybranym zakresie.</p>}
    {history && history.samples.length > 0 && paths && <>
      <div className="chart-legend"><span className="legend-key cpu"><span />CPU</span><span className="legend-key ram"><span />RAM</span></div>
      <div className="plot">
        <div className="y-axis" aria-hidden="true">{[100, 75, 50, 25, 0].map((value) => <span key={value}>{value}%</span>)}</div>
        <div className="plot-area">
          <div className="plot-grid" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label={'Historia CPU i RAM od ' + dateTime.format(start) + ' do ' + dateTime.format(history.at)}>
            <path d={paths.ram} className="ram-line" vectorEffect="non-scaling-stroke" />
            <path d={paths.cpu} className="cpu-line" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <div className="x-axis" aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => start + index * duration / 4).map((time) => <span key={time}>{formatTime(time)}</span>)}
        </div>
      </div>
    </>}
  </section>
}
