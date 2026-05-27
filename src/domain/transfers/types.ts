export interface AttachmentTransferState {
  request_id: string
  message_id: string
  attachment_id: string
  from_user_id: string
  to_user_id: string
  file_name: string
  direction: 'upload' | 'download'
  status: 'queued' | 'requesting' | 'connecting' | 'transferring' | 'completed' | 'rejected' | 'failed'
  progress: number
  debug_kbps?: number
  debug_buffered_bytes?: number
  debug_pending_bytes?: number
  debug_eta_seconds?: number
  saved_path?: string
  error?: string
  sha256?: string
  /** Cordia server signing pubkey for this session (incoming uploads: message's server). */
  server_signing_pubkey?: string
}

export interface TransferHistoryEntry {
  request_id: string
  message_id: string
  attachment_id: string
  file_name: string
  size_bytes?: number
  from_user_id: string
  to_user_id: string
  direction: 'upload' | 'download'
  status: AttachmentTransferState['status']
  progress: number
  saved_path?: string
  is_inaccessible?: boolean
  created_at: string
  updated_at: string
  /** Cordia server for this session (uploads you sent); persisted for seeding downloader list. */
  server_signing_pubkey?: string
}

export type TransferSession = AttachmentTransferState
