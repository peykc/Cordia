export type ServerShareRecord = {
  serverSigningPubkey: string
  contentId: string
  sharedAt?: string
}

export type ShareStatus = 'shared_here' | 'shared_elsewhere' | 'not_shared'

export type ServerSharedShaState = Record<string, string[]>
