export type SwarmPeerInfo = {
  user_id: string
  seeding: boolean
  piece_count: number
  upload_kbps?: number | null
  quality_score?: number | null
  leechers?: number | null
  updated_at_unix_ms: number
}

export type SwarmPeerListResponse = {
  signing_pubkey: string
  sha256: string
  peers: SwarmPeerInfo[]
}

export type SwarmResumeState = {
  swarm_key: string
  sha256?: string | null
  piece_size: number
  piece_count: number
  bitfield: boolean[]
  target_path: string
  updated_at: string
}

export type PieceAvailability = {
  pieceIndex: number
  peerCount: number
}
