import { useEffect, useState } from 'react'

export type Connection = {
  health: 'loading' | 'ok' | 'error'
  updatedAt: number | null
}

export function useFeed<T extends Connection>(path: string | null, initial: T, verifySession: () => Promise<void>, staleAfter?: number) {
  const [state, setState] = useState(initial)
  useEffect(() => {
    setState(initial)
    if (!path) return
    const source = new EventSource(path)
    let timer: number | undefined
    const markError = () => setState((previous) => ({ ...previous, health: 'error' }))
    const waitForSample = () => {
      window.clearTimeout(timer)
      if (staleAfter) timer = window.setTimeout(markError, staleAfter)
    }
    waitForSample()
    source.onmessage = ({ data }) => {
      waitForSample()
      try {
        setState(JSON.parse(data) as T)
      } catch {
        markError()
      }
    }
    source.onerror = () => {
      markError()
      void verifySession()
    }
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [path, initial, verifySession, staleAfter])
  return path ? state : initial
}
