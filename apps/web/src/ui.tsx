import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { AlertCircle, Box, CheckCircle2, Info, LoaderCircle } from 'lucide-react'

export function Brand() {
  return <span className="brand"><span className="brand-icon"><Box size={21} strokeWidth={2.1} /></span><span className="brand-name"><strong>MCC</strong><small>Minecraft Control Center</small></span></span>
}

type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  loading?: boolean
}

export function Button({ variant = 'secondary', loading = false, type = 'button', className = '', children, onClick, ...props }: ButtonProps) {
  return (
    <button {...props} type={type} className={('button ' + variant + ' ' + className).trim()} aria-busy={loading || undefined} aria-disabled={loading || undefined} onClick={(event) => {
      if (loading) {
        event.preventDefault()
        return
      }
      onClick?.(event)
    }}>
      {loading && <LoaderCircle className="spinner" size={16} aria-hidden="true" />}{children}
    </button>
  )
}

export function IconButton({ className = '', type = 'button', ...props }: ComponentPropsWithoutRef<'button'> & { 'aria-label': string }) {
  return <button {...props} type={type} className={('icon-button ' + className).trim()} />
}

export function PanelHeading({ title, description, id, children }: { title: string; description?: string; id?: string; children?: ReactNode }) {
  return <div className="panel-heading"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div>{children}</div>
}

export function ServerStatus({ online }: { online: boolean }) {
  return <span className={online ? 'status online' : 'status offline'}><span aria-hidden="true" />{online ? 'Online' : 'Offline'}</span>
}

export function SegmentedControl<T extends string>({ label, options, value, onChange }: {
  label: string
  options: readonly T[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => <button key={option} type="button" onClick={() => onChange(option)} aria-pressed={value === option}>{option}</button>)}
    </div>
  )
}

const noticeIcons = { neutral: Info, success: CheckCircle2, error: AlertCircle }

export function Notice({ tone = 'neutral', title, children }: { tone?: keyof typeof noticeIcons; title: string; children?: ReactNode }) {
  const Icon = noticeIcons[tone]
  return <div className={'notice ' + tone}><Icon size={19} aria-hidden="true" /><div><strong>{title}</strong>{children && <div>{children}</div>}</div></div>
}
