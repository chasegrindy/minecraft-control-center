import type { WorldLocation } from './demo'
import { useFeed } from './live-feed'
import type { Connection } from './live-feed'

export const positionDimensions = { overworld: 'Overworld', nether: 'Nether', end: 'End' }
type PositionPlayer = { uuid: string; name: string }
export type PlayerPosition = WorldLocation & PositionPlayer
export type PlayerMapTarget = PositionPlayer & { seenAt: number }
type PositionsFeed = Connection & { positions: PlayerPosition[] }
const loading: PositionsFeed = { health: 'loading', updatedAt: null, positions: [] }

export function usePlayerPositions(enabled: boolean, verifySession: () => Promise<void>) {
  return useFeed(enabled ? '/api/mcc/map-players' : null, loading, verifySession, 7500)
}
