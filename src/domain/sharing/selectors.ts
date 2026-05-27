import type { ServerSharedShaState, ShareStatus } from './types'

export function getServersForContentSha(serverSharedSha: ServerSharedShaState, sha256: string | undefined): string[] {
  const normalized = sha256?.trim()
  if (!normalized) return []
  return Object.keys(serverSharedSha).filter((serverKey) => {
    const shas = serverSharedSha[serverKey]
    return Array.isArray(shas) && shas.includes(normalized)
  })
}

export function isContentSharedInServer(
  serverSharedSha: ServerSharedShaState,
  serverSigningPubkey: string | undefined,
  sha256: string | undefined
): boolean {
  const serverKey = serverSigningPubkey?.trim()
  const normalized = sha256?.trim()
  if (!serverKey || !normalized) return false
  return Array.isArray(serverSharedSha[serverKey]) && serverSharedSha[serverKey].includes(normalized)
}

export function selectShareStatus({
  serverSharedSha,
  currentServerSigningPubkey,
  sha256,
}: {
  serverSharedSha: ServerSharedShaState
  currentServerSigningPubkey?: string
  sha256?: string
}): ShareStatus {
  if (isContentSharedInServer(serverSharedSha, currentServerSigningPubkey, sha256)) return 'shared_here'
  return getServersForContentSha(serverSharedSha, sha256).length > 0 ? 'shared_elsewhere' : 'not_shared'
}

export function invertServerSharedSha(serverSharedSha: ServerSharedShaState): Map<string, string[]> {
  const serversBySha = new Map<string, string[]>()
  for (const [serverKey, shas] of Object.entries(serverSharedSha)) {
    if (!Array.isArray(shas)) continue
    for (const sha of shas) {
      const normalized = typeof sha === 'string' ? sha.trim() : ''
      if (!normalized) continue
      const servers = serversBySha.get(normalized)
      if (servers) servers.push(serverKey)
      else serversBySha.set(normalized, [serverKey])
    }
  }
  return serversBySha
}
