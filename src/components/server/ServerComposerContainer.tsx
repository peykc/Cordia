import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { open, confirm } from '@tauri-apps/api/dialog'
import { getAttachmentRecord } from '../../lib/tauri'
import { enqueueStagedAttachmentAdd } from '../../lib/stagedAttachmentAddPipeline'
import { getDraft, setDraft, clearDraft } from '../../lib/messageDrafts'
import { ServerComposer, type StagedAttachment } from './ServerComposer'

export interface ServerComposerContainerProps {
  serverId: string
  signingPubkey: string
  chatId: string
  currentUserId: string
  currentAccountId: string | null
  canSendMessages: boolean
  beaconStatus: string
  onSendMessage: (text: string, staged: StagedAttachment[]) => Promise<void>
  onMediaPreview: (opts: any) => void
}

export function ServerComposerContainer({
  serverId: _serverId,
  signingPubkey,
  chatId: _chatId,
  currentUserId: _currentUserId,
  currentAccountId,
  canSendMessages,
  beaconStatus,
  onSendMessage,
  onMediaPreview,
}: ServerComposerContainerProps) {
  const [composerHasText, setComposerHasText] = useState(false)
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([])
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null)
  const draftValueRef = useRef('')
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLineCountRef = useRef(0)

  const MESSAGE_INPUT_MAX_HEIGHT = 100
  const DRAFT_SAVE_DEBOUNCE_MS = 300
  const MESSAGE_MAX_LENGTH = 2500

  const adjustComposerHeight = useCallback(() => {
    const el = messageInputRef.current
    if (!el) return
    const val = el.value
    const lineCount = (val.match(/\n/g) || []).length
    if (lineCount === lastLineCountRef.current && val.length > 0 && val.length < 1990) {
      if (lineCount === 0 && val.length % 40 !== 0) return 
    }
    lastLineCountRef.current = lineCount
    requestAnimationFrame(() => {
      el.style.height = 'auto'
      const capped = Math.min(el.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT)
      el.style.height = `${capped}px`
      const isScrollable = el.scrollHeight > MESSAGE_INPUT_MAX_HEIGHT
      el.style.overflowY = isScrollable ? 'auto' : 'hidden'
      if (isScrollable && el.selectionStart === el.value.length) {
        el.scrollTop = el.scrollHeight
      }
    })
  }, [MESSAGE_INPUT_MAX_HEIGHT])

  const handleDraftChange = useCallback((value: string) => {
    draftValueRef.current = value
    if (!currentAccountId || !signingPubkey) return
    if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current)
    draftSaveTimeoutRef.current = setTimeout(() => {
      setDraft(currentAccountId, signingPubkey, value)
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }, [currentAccountId, signingPubkey])

  // Load draft on mount or server change
  useEffect(() => {
    if (!currentAccountId || !signingPubkey) return
    const draft = getDraft(currentAccountId, signingPubkey)
    if (draft) {
      draftValueRef.current = draft
      if (messageInputRef.current) {
        messageInputRef.current.value = draft
        setComposerHasText(draft.trim().length > 0)
        adjustComposerHeight()
      }
    } else {
      draftValueRef.current = ''
      if (messageInputRef.current) {
        messageInputRef.current.value = ''
        setComposerHasText(false)
        adjustComposerHeight()
      }
    }
  }, [currentAccountId, signingPubkey, adjustComposerHeight])

  const handleAddAttachment = useCallback(async () => {
    try {
      const selected = await open({ title: 'Select attachment(s)', multiple: true })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      const copyToCordia = await confirm(
        `Copy ${paths.length} file(s) into Cordia storage when sending?`,
        { title: 'Attachment storage', okLabel: 'Copy to Cordia', cancelLabel: 'Keep current path' }
      )
      const storage_mode = copyToCordia ? 'program_copy' : 'current_path'
      await enqueueStagedAttachmentAdd(paths, storage_mode, setStagedAttachments)
    } catch (e) { console.warn('Add attachment failed:', e) }
  }, [])

  const handleRemoveStagedAttachment = useCallback((id: string) => {
    setStagedAttachments((prev) => prev.filter((a) => a.staged_id !== id))
  }, [])

  const handleToggleStagedSpoiler = useCallback((id: string) => {
    setStagedAttachments((prev) => prev.map((a) => a.staged_id === id ? { ...a, spoiler: !a.spoiler } : a))
  }, [])

  const handleInternalSendMessage = useCallback(async () => {
    const text = draftValueRef.current.trim().slice(0, MESSAGE_MAX_LENGTH)
    const staged = [...stagedAttachments]
    if (!text && staged.length === 0) return

    // Optimistic clear
    draftValueRef.current = ''
    setComposerHasText(false)
    setStagedAttachments([])
    if (messageInputRef.current) {
      messageInputRef.current.value = ''
      adjustComposerHeight()
    }
    if (currentAccountId) clearDraft(currentAccountId, signingPubkey)

    try {
      await onSendMessage(text, staged)
    } catch (e) {
      // Restore on failure
      draftValueRef.current = text
      setComposerHasText(text.length > 0)
      setStagedAttachments(staged)
      if (messageInputRef.current) {
        messageInputRef.current.value = text
        adjustComposerHeight()
      }
      console.warn('Send failed:', e)
    }
  }, [stagedAttachments, signingPubkey, currentAccountId, onSendMessage, adjustComposerHeight])

  // Listen for attachment readiness and SHA progress
  useEffect(() => {
    const unlistenReady = listen<{ attachment_id: string; ok: boolean }>(
      'cordia:attachment-ready',
      (event) => {
        const { attachment_id, ok } = event.payload
        if (!ok) return
        getAttachmentRecord(attachment_id).then(rec => {
          setStagedAttachments(prev => prev.map(a => 
            a.attachment_id === attachment_id ? { ...a, ready: true, thumbnail_path: rec?.thumbnail_path } : a
          ))
        })
      }
    )
    const unlistenProgress = listen<{ attachment_id: string; percent: number }>(
      'cordia:attachment-sha-progress',
      (event) => {
        const { attachment_id, percent } = event.payload
        setStagedAttachments(prev => prev.map(a => 
          a.attachment_id === attachment_id ? { ...a, preparePercent: Math.round(percent) } : a
        ))
      }
    )
    return () => {
      unlistenReady.then(f => f())
      unlistenProgress.then(f => f())
    }
  }, [])

  return (
    <ServerComposer
      messageInputRef={messageInputRef}
      composerHasText={composerHasText}
      setComposerHasText={setComposerHasText}
      adjustComposerHeight={adjustComposerHeight}
      onDraftChange={handleDraftChange}
      canSendMessages={canSendMessages}
      beaconStatus={beaconStatus}
      stagedAttachments={stagedAttachments}
      messageMaxLength={MESSAGE_MAX_LENGTH}
      messageInputMaxHeight={MESSAGE_INPUT_MAX_HEIGHT}
      onSendMessage={handleInternalSendMessage}
      onAddAttachment={handleAddAttachment}
      onRemoveStagedAttachment={handleRemoveStagedAttachment}
      onToggleStagedSpoiler={handleToggleStagedSpoiler}
      onMediaPreview={onMediaPreview}
    />
  )
}
