const shareHandlers = new Map<string, () => void>()

export function registerChatPreviewShareHandler(attachmentRefId: string, handler: () => void): void {
  shareHandlers.set(attachmentRefId, handler)
}

export function consumeChatPreviewShareHandler(attachmentRefId: string): (() => void) | undefined {
  const handler = shareHandlers.get(attachmentRefId)
  return handler
}

export function clearChatPreviewShareHandlers(): void {
  shareHandlers.clear()
}
