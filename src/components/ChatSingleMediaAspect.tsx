import { memo, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import type { EphemeralAttachmentMeta } from '../contexts/EphemeralMessagesContext'

type Aspect = { w: number; h: number }

/**
 * Manages aspect ratio state for a single media attachment. Uses aspect from
 * message when available; otherwise learns from img/video load and persists
 * to the message bucket. Only this component re-renders when aspect is learned,
 * not the parent chat.
 */
function ChatSingleMediaAspectImpl({
  msgId,
  attachmentId,
  att,
  isSingle,
  signingPubkey,
  chatId,
  updateAttachmentAspect,
  children,
}: {
  msgId: string
  attachmentId: string
  att: EphemeralAttachmentMeta
  isSingle: boolean
  signingPubkey: string
  chatId: string
  updateAttachmentAspect: (
    signingPubkey: string,
    chatId: string,
    messageId: string,
    attachmentId: string,
    aspect: { w: number; h: number }
  ) => void
  children: (props: {
    aspect: Aspect
    onImageLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void
    onVideoMetadata?: (e: React.SyntheticEvent<HTMLVideoElement>) => void
    onVideoAspect?: (w: number, h: number) => void
  }) => ReactNode
}) {
  const fromMessage: Aspect | null =
    att.aspect_ratio_w != null && att.aspect_ratio_h != null
      ? { w: att.aspect_ratio_w, h: att.aspect_ratio_h }
      : null

  const [learnedAspect, setLearnedAspect] = useState<Aspect | null>(null)

  const effectiveAspect: Aspect = fromMessage ?? learnedAspect ?? { w: 1, h: 1 }

  const persistAndSet = useCallback(
    (w: number, h: number) => {
      if (w <= 0 || h <= 0) return
      if (fromMessage && fromMessage.w === w && fromMessage.h === h) return
      if (learnedAspect && learnedAspect.w === w && learnedAspect.h === h) return
      setLearnedAspect({ w, h })
      updateAttachmentAspect(signingPubkey, chatId, msgId, attachmentId, { w, h })
    },
    [signingPubkey, chatId, msgId, attachmentId, updateAttachmentAspect, fromMessage, learnedAspect]
  )

  const onImageLoad = isSingle && !fromMessage
    ? useCallback(
        (e: React.SyntheticEvent<HTMLImageElement>) => {
          const img = e.currentTarget
          if (img.naturalWidth && img.naturalHeight) {
            persistAndSet(img.naturalWidth, img.naturalHeight)
          }
        },
        [persistAndSet]
      )
    : undefined

  const onVideoMetadata = isSingle && !fromMessage
    ? useCallback(
        (e: React.SyntheticEvent<HTMLVideoElement>) => {
          const v = e.currentTarget
          if (v.videoWidth && v.videoHeight) {
            persistAndSet(v.videoWidth, v.videoHeight)
          }
        },
        [persistAndSet]
      )
    : undefined

  const onVideoAspect = isSingle && !fromMessage
    ? useCallback(
        (w: number, h: number) => {
          persistAndSet(w, h)
        },
        [persistAndSet]
      )
    : undefined

  return <>{children({ aspect: effectiveAspect, onImageLoad, onVideoMetadata, onVideoAspect })}</>
}

export const ChatSingleMediaAspect = memo(ChatSingleMediaAspectImpl)
