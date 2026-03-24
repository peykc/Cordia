import type { PieceAvailability } from './types'

type PeerBitfieldMap = Record<string, boolean[]>

export class PieceScheduler {
  private readonly pieceCount: number
  private readonly localHave: boolean[]
  private readonly peerBitfields: PeerBitfieldMap = {}

  constructor(pieceCount: number, initialHave?: boolean[]) {
    this.pieceCount = Math.max(0, pieceCount)
    this.localHave = Array.from({ length: this.pieceCount }, (_, i) => Boolean(initialHave?.[i]))
  }

  setPeerBitfield(peerId: string, bitfield: boolean[]): void {
    this.peerBitfields[peerId] = bitfield.slice(0, this.pieceCount)
  }

  removePeer(peerId: string): void {
    delete this.peerBitfields[peerId]
  }

  markHave(pieceIndex: number): void {
    if (pieceIndex < 0 || pieceIndex >= this.pieceCount) return
    this.localHave[pieceIndex] = true
  }

  getMissingPieceCount(): number {
    let missing = 0
    for (let i = 0; i < this.pieceCount; i += 1) {
      if (!this.localHave[i]) missing += 1
    }
    return missing
  }

  getAvailability(): PieceAvailability[] {
    const counts = new Array<number>(this.pieceCount).fill(0)
    Object.values(this.peerBitfields).forEach((bf) => {
      for (let i = 0; i < Math.min(this.pieceCount, bf.length); i += 1) {
        if (bf[i]) counts[i] += 1
      }
    })
    return counts.map((peerCount, pieceIndex) => ({ pieceIndex, peerCount }))
  }

  /**
   * Rarest-first piece choice for one peer, skipping pieces we already have.
   */
  pickNextPieceForPeer(peerId: string, inFlight: Set<number>): number | null {
    const peerBitfield = this.peerBitfields[peerId]
    if (!peerBitfield?.length) return null
    const availability = this.getAvailability()
      .filter((a) => a.peerCount > 0)
      .sort((a, b) => a.peerCount - b.peerCount)
    for (const a of availability) {
      const idx = a.pieceIndex
      if (this.localHave[idx]) continue
      if (inFlight.has(idx)) continue
      if (!peerBitfield[idx]) continue
      return idx
    }
    return null
  }
}
