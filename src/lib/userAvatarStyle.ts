import type { CSSProperties } from 'react'

/** Same hash as ServerViewPage `hashId` — stable per user id for placeholder colors. */
export function hashUserId(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  return hash
}

/** Matches ServerViewPage `avatarStyleForUser` / chat timeline placeholders. */
export function avatarStyleForUserId(userId: string): CSSProperties {
  const h = hashUserId(userId) % 360
  return {
    backgroundColor: `hsl(${h}, 45%, 35%)`,
    color: '#fff',
  }
}
