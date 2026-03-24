import type { SwarmPeerInfo, SwarmPeerListResponse } from './types'

type PeerListResolver = {
  resolve: (peers: SwarmPeerInfo[]) => void
  reject: (error: Error) => void
  timeout: number
}

function key(signingPubkey: string, sha256: string): string {
  return `${signingPubkey}::${sha256}`
}

export class SwarmCoordinator {
  private readonly pending = new Map<string, PeerListResolver>()
  private readonly onPeerListIncoming = (ev: Event) => {
    const detail = (ev as CustomEvent<SwarmPeerListResponse>).detail
    const signingPubkey = detail?.signing_pubkey?.trim()
    const sha256 = detail?.sha256?.trim()
    if (!signingPubkey || !sha256) return
    const k = key(signingPubkey, sha256)
    const entry = this.pending.get(k)
    if (!entry) return
    window.clearTimeout(entry.timeout)
    this.pending.delete(k)
    entry.resolve(Array.isArray(detail.peers) ? detail.peers : [])
  }

  start(): void {
    window.addEventListener('cordia:swarm-peer-list-response-incoming', this.onPeerListIncoming as EventListener)
  }

  stop(): void {
    window.removeEventListener('cordia:swarm-peer-list-response-incoming', this.onPeerListIncoming as EventListener)
    for (const [, entry] of this.pending) {
      window.clearTimeout(entry.timeout)
      entry.reject(new Error('Swarm coordinator stopped'))
    }
    this.pending.clear()
  }

  announce(
    signingPubkey: string,
    sha256: string,
    payload?: { seeding?: boolean; pieceCount?: number; uploadKbps?: number; qualityScore?: number }
  ): void {
    window.dispatchEvent(
      new CustomEvent('cordia:send-swarm-announce', {
        detail: {
          signing_pubkey: signingPubkey,
          sha256,
          seeding: Boolean(payload?.seeding),
          piece_count: Math.max(1, Number(payload?.pieceCount ?? 1)),
          upload_kbps: payload?.uploadKbps,
          quality_score: payload?.qualityScore,
        },
      })
    )
  }

  unannounce(signingPubkey: string, sha256: string): void {
    window.dispatchEvent(
      new CustomEvent('cordia:send-swarm-unannounce', {
        detail: { signing_pubkey: signingPubkey, sha256 },
      })
    )
  }

  updateHealth(
    signingPubkey: string,
    sha256: string,
    payload?: { uploadKbps?: number; qualityScore?: number; leechers?: number }
  ): void {
    window.dispatchEvent(
      new CustomEvent('cordia:send-swarm-health-update', {
        detail: {
          signing_pubkey: signingPubkey,
          sha256,
          upload_kbps: payload?.uploadKbps,
          quality_score: payload?.qualityScore,
          leechers: payload?.leechers,
        },
      })
    )
  }

  requestPeers(signingPubkey: string, sha256: string, maxPeers = 24, timeoutMs = 5000): Promise<SwarmPeerInfo[]> {
    const k = key(signingPubkey, sha256)
    const existing = this.pending.get(k)
    if (existing) {
      window.clearTimeout(existing.timeout)
      existing.reject(new Error('Superseded by a newer peer list request'))
      this.pending.delete(k)
    }
    return new Promise<SwarmPeerInfo[]>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(k)
        reject(new Error('Swarm peer list timeout'))
      }, timeoutMs)
      this.pending.set(k, { resolve, reject, timeout })
      window.dispatchEvent(
        new CustomEvent('cordia:send-swarm-peer-list-request', {
          detail: {
            signing_pubkey: signingPubkey,
            sha256,
            max_peers: maxPeers,
          },
        })
      )
    })
  }
}
