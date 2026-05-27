const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false

export type DevStressAttachmentKind = 'image' | 'video' | 'audio' | 'file'

export type DevStressAttachment = {
  attachmentId: string
  messageId: string
  kind: DevStressAttachmentKind
  fileName: string
  sizeBytes: number
  sha256: string
  available: boolean
}

export type DevStressMessage = {
  id: string
  chatId: string
  fromUserId: string
  sentAt: string
  text: string
  attachmentIds: string[]
}

export type DevStressTransfer = {
  requestId: string
  attachmentId: string
  direction: 'download' | 'upload'
  status: 'queued' | 'requesting' | 'connecting' | 'transferring'
  progress: number
}

export type DevStressFixture = {
  messages: DevStressMessage[]
  attachments: DevStressAttachment[]
  transfers: DevStressTransfer[]
}

export type DevStressFixtureOptions = {
  messageCount: number
  attachmentCount: number
  transferCount: number
}

const ATTACHMENT_KINDS: DevStressAttachmentKind[] = ['image', 'video', 'audio', 'file']
const TINY_DEV_STRESS_OPTIONS: DevStressFixtureOptions = {
  messageCount: 200,
  attachmentCount: 50,
  transferCount: 10,
}
const HEAVY_DEV_STRESS_OPTIONS: DevStressFixtureOptions = {
  messageCount: 1_000,
  attachmentCount: 400,
  transferCount: 20,
}

/**
 * Dev-only fixture for manual render/performance probes.
 *
 * This intentionally does not wire itself into production UI. Import it from a
 * temporary dev route or console probe when measuring broad rerenders.
 */
export function createDevStressFixture(options: DevStressFixtureOptions = TINY_DEV_STRESS_OPTIONS): DevStressFixture {
  if (!DEV) {
    return { messages: [], attachments: [], transfers: [] }
  }

  const messages: DevStressMessage[] = []
  const attachments: DevStressAttachment[] = []
  const transfers: DevStressTransfer[] = []
  const now = Date.now()

  for (let i = 0; i < options.messageCount; i += 1) {
    const id = `dev-msg-${i + 1}`
    const attachmentIds: string[] = []

    if (i < options.attachmentCount) {
      const kind = ATTACHMENT_KINDS[i % ATTACHMENT_KINDS.length]
      const attachmentId = `dev-att-${i + 1}`
      attachmentIds.push(attachmentId)
      attachments.push({
        attachmentId,
        messageId: id,
        kind,
        fileName: `fixture-${i + 1}.${kind === 'file' ? 'bin' : kind}`,
        sizeBytes: 64_000 + i * 1_024,
        sha256: `dev-sha-${String(i % 25).padStart(2, '0')}`,
        available: i % 7 !== 0,
      })
    }

    messages.push({
      id,
      chatId: 'dev-stress-chat',
      fromUserId: i % 3 === 0 ? 'dev-peer-a' : 'dev-peer-b',
      sentAt: new Date(now - i * 30_000).toISOString(),
      text: `Dev stress message ${i + 1}`,
      attachmentIds,
    })
  }

  for (let i = 0; i < options.transferCount; i += 1) {
    transfers.push({
      requestId: `dev-transfer-${i + 1}`,
      attachmentId: `dev-att-${i + 1}`,
      direction: i % 3 === 0 ? 'upload' : 'download',
      status: i % 4 === 0 ? 'queued' : 'transferring',
      progress: Math.min(0.95, (i + 1) / 12),
    })
  }

  return { messages, attachments, transfers }
}

export function createHeavyDevStressFixture(): DevStressFixture {
  return createDevStressFixture(HEAVY_DEV_STRESS_OPTIONS)
}
