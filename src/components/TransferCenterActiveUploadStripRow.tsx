import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { User } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { Button } from './ui/button'
import { FilenameEllipsis } from './FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import type { SharedAttachmentItem } from '../lib/tauri'
import type { AttachmentTransferState } from '../contexts/EphemeralMessagesContext'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { useMediaPreview } from '../contexts/MediaPreviewContext'
import { transferListThumbnailPath } from '../lib/transferListMedia'
import { cn } from '../lib/utils'

export type ActiveUploadGroup = { attachmentId: string; transfers: AttachmentTransferState[] }

function formatEta(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.max(0, Math.round(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function formatRate(kbps?: number): string {
  const safe = Math.max(0, kbps ?? 0)
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} MB/s`
  return `${Math.round(safe)} KB/s`
}

function formatBuffer(bytes?: number): string {
  if (bytes == null || bytes <= 0) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB buf`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB buf`
  return `${bytes} B buf`
}

function statusRank(s: AttachmentTransferState['status']): number {
  switch (s) {
    case 'transferring':
      return 0
    case 'connecting':
      return 1
    case 'requesting':
      return 2
    case 'queued':
      return 3
    default:
      return 9
  }
}

function pickPrimaryUpload(transfers: AttachmentTransferState[]): AttachmentTransferState {
  return [...transfers].sort((a, b) => {
    const ra = statusRank(a.status)
    const rb = statusRank(b.status)
    if (ra !== rb) return ra - rb
    return (b.progress ?? 0) - (a.progress ?? 0)
  })[0]!
}

type Props = { group: ActiveUploadGroup; shared: SharedAttachmentItem | undefined }

function TransferCenterActiveUploadStripRowInner({ group, shared }: Props) {
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const { findMessageById } = useEphemeralMessages()
  const { setMediaPreview } = useMediaPreview()
  const { transfers } = group

  const [menuOpen, setMenuOpen] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setAnchorRect(null)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (menuButtonRef.current?.contains(target)) return
      closeMenu()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [menuOpen, closeMenu])

  const peerLabel = useCallback(
    (uid: string) =>
      uid === identity?.user_id
        ? 'You'
        : remoteProfiles.getProfile(uid)?.display_name?.trim() || `User ${uid.slice(0, 8)}`,
    [identity?.user_id, remoteProfiles]
  )

  const peerEntries = useMemo(() => {
    const seen = new Set<string>()
    const out: { userId: string; label: string }[] = []
    for (const t of transfers) {
      if (seen.has(t.to_user_id)) continue
      seen.add(t.to_user_id)
      out.push({ userId: t.to_user_id, label: peerLabel(t.to_user_id) })
    }
    return out
  }, [transfers, peerLabel])

  const primary = pickPrimaryUpload(transfers)
  const maxPct = Math.max(
    0,
    Math.min(100, ...transfers.map((t) => Math.round((t.progress ?? 0) * 100)))
  )
  const sumKbps = transfers.reduce((acc, t) => acc + Math.max(0, t.debug_kbps ?? 0), 0)
  const showLive = transfers.some(
    (t) =>
      t.status === 'queued' ||
      t.status === 'requesting' ||
      t.status === 'connecting' ||
      t.status === 'transferring'
  )

  const fileName = shared?.file_name ?? primary.file_name
  const sb = shared?.size_bytes
  const sizePart = sb != null && Number.isFinite(Number(sb)) ? formatBytes(sb) : '—'

  const tierThumb = transferListThumbnailPath(
    fileName,
    shared?.thumbnail_path ?? undefined,
    shared?.file_path ?? undefined
  )

  const onPreview = useCallback(
    (
      url: string | null,
      type: 'image' | 'video' | 'audio',
      aid?: string,
      fn?: string,
      opts?: { musicCoverFullSourcePath?: string | null; localPath?: string | null }
    ) => {
      const uid = primary.from_user_id
      const isYou = uid === identity?.user_id
      const rp = remoteProfiles.getProfile(uid)
      const sentAt = findMessageById(primary.message_id)?.sent_at ?? new Date().toISOString()
      const base = {
        attachmentId: aid,
        fileName: fn ?? fileName,
        source: 'transfers' as const,
        originUserId: uid,
        originSentAtIso: sentAt,
        originDisplayName: isYou ? identity?.display_name ?? 'You' : rp?.display_name?.trim() || `User ${uid.slice(0, 8)}`,
        originAvatarDataUrl: isYou ? profile.avatar_data_url ?? null : rp?.avatar_data_url ?? null,
        sizeBytes: shared?.size_bytes,
        sha256: shared?.sha256 ?? primary.sha256,
      }
      if (type === 'audio') {
        const lp = opts?.localPath?.trim() ?? shared?.file_path?.trim()
        if (!lp) return
        setMediaPreview({
          type: 'audio',
          localPath: lp,
          musicCoverFullSourcePath: opts?.musicCoverFullSourcePath ?? null,
          ...base,
        })
        return
      }
      setMediaPreview({
        type,
        url,
        ...base,
        localPath: shared?.file_path ?? null,
        musicCoverFullSourcePath: opts?.musicCoverFullSourcePath ?? null,
      })
    },
    [
      primary.from_user_id,
      primary.message_id,
      primary.sha256,
      fileName,
      shared?.file_path,
      shared?.size_bytes,
      shared?.sha256,
      identity?.user_id,
      identity?.display_name,
      profile.avatar_data_url,
      remoteProfiles,
      findMessageById,
      setMediaPreview,
    ]
  )

  const sortedTransfers = useMemo(
    () =>
      [...transfers].sort((a, b) => {
        const la = peerLabel(a.to_user_id)
        const lb = peerLabel(b.to_user_id)
        if (la !== lb) return la.localeCompare(lb)
        return a.request_id.localeCompare(b.request_id)
      }),
    [transfers, peerLabel]
  )

  const peerCount = peerEntries.length

  const recipientNamesTitle = useMemo(() => peerEntries.map((p) => p.label).join(', '), [peerEntries])

  const metaRowTitle = useMemo(() => {
    const names = recipientNamesTitle || 'Recipients'
    if (primary.status === 'queued') return `${peerCount} | ${sizePart} | ${names} | Queued`
    if (showLive) {
      const rate = formatRate(sumKbps > 0 ? sumKbps : primary.debug_kbps)
      const eta = formatEta(primary.debug_eta_seconds)
      const buf =
        primary.debug_buffered_bytes != null && primary.debug_buffered_bytes > 64 * 1024
          ? ` | ${formatBuffer(primary.debug_buffered_bytes)}`
          : ''
      return `${peerCount} | ${sizePart} | ${names} | ${rate} | ETA ${eta}${buf}`
    }
    return `${peerCount} | ${sizePart} | ${names}`
  }, [
    recipientNamesTitle,
    sizePart,
    peerCount,
    primary.status,
    primary.debug_kbps,
    primary.debug_eta_seconds,
    primary.debug_buffered_bytes,
    showLive,
    sumKbps,
  ])

  return (
    <>
      <div className="group flex items-center gap-2 border-b border-border px-2 py-1 transition-colors duration-150 hover:bg-muted/50">
        <FileIcon
          fileName={fileName}
          attachmentId={shared?.attachment_id ?? null}
          savedPath={shared?.file_path ?? undefined}
          thumbnailPath={tierThumb}
          boxSize={32}
          squareThumb
          deferThumbnailWork
          onMediaClick={onPreview}
        />
        <div className="min-w-0 flex-1">
          <FilenameEllipsis
            name={fileName}
            className="block min-w-0 h-4 text-[11px] font-medium leading-4 text-foreground"
          />
          <div className="mt-px grid min-w-0 grid-cols-[minmax(0,1fr)_6.125rem] gap-x-2 items-center">
            <div className="flex min-w-0 items-center gap-1 overflow-hidden" title={metaRowTitle}>
              <Button
                ref={menuButtonRef}
                type="button"
                variant="ghost"
                className={cn(
                  'h-6 shrink-0 gap-1 rounded-md border px-1.5 text-[10px] font-medium tabular-nums transition-colors',
                  menuOpen
                    ? 'border-accent/55 bg-accent/15 text-foreground shadow-sm'
                    : 'border-border/60 bg-muted/25 text-muted-foreground hover:bg-muted/45 hover:text-foreground'
                )}
                title={recipientNamesTitle ? `Recipients: ${recipientNamesTitle}` : 'Recipients'}
                aria-expanded={menuOpen}
                aria-haspopup="dialog"
                onClick={(e) => {
                  const el = e.currentTarget
                  const rect = el.getBoundingClientRect()
                  if (menuOpen) {
                    closeMenu()
                    return
                  }
                  setAnchorRect(rect)
                  setMenuOpen(true)
                }}
              >
                <User className="h-3 w-3 shrink-0 opacity-90" aria-hidden />
                <span>{peerCount}</span>
              </Button>
              <span className="shrink-0 text-[10px] text-muted-foreground/80" aria-hidden>
                |
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{sizePart}</span>
              {(primary.status === 'queued' || showLive) && (
                <>
                  <span className="shrink-0 text-[10px] text-muted-foreground/80" aria-hidden>
                    |
                  </span>
                  <p className="min-w-0 flex-1 truncate text-[10px] leading-tight text-muted-foreground whitespace-nowrap tabular-nums">
                    {primary.status === 'queued' ? (
                      <span>Queued</span>
                    ) : (
                      <>
                        <span>{formatRate(sumKbps > 0 ? sumKbps : primary.debug_kbps)}</span>
                        <span> | </span>
                        <span>ETA {formatEta(primary.debug_eta_seconds)}</span>
                        {primary.debug_buffered_bytes != null && primary.debug_buffered_bytes > 64 * 1024 && (
                          <span title="Upload send buffer">
                            {' '}
                            | {formatBuffer(primary.debug_buffered_bytes)}
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="h-0.5 w-[4.125rem] shrink-0 rounded-full bg-foreground/10 overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full',
                    primary.status === 'completed' ? 'bg-emerald-500/80' : 'bg-violet-500/70'
                  )}
                  style={{ width: `${Math.max(0, maxPct)}%` }}
                />
              </div>
              <span className="w-[1.625rem] shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                {maxPct}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {menuOpen &&
        anchorRect &&
        createPortal(
          <div
            ref={menuRef}
            className="max-h-[min(240px,50vh)] min-w-[200px] overflow-y-auto overscroll-contain rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg z-[9999]"
            style={{
              position: 'fixed',
              right: window.innerWidth - anchorRect.right,
              top: anchorRect.bottom + 2,
            }}
          >
            <p className="px-2 pb-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Recipients</p>
            {sortedTransfers.map((t) => (
              <div
                key={t.request_id}
                className="border-b border-border/40 px-2 py-1.5 text-[11px] last:border-b-0"
              >
                <div className="truncate font-medium">{peerLabel(t.to_user_id)}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {t.status}
                  {' | '}
                  {formatRate(t.debug_kbps)}
                  {' | '}
                  ETA {formatEta(t.debug_eta_seconds)}
                </div>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

export const TransferCenterActiveUploadStripRow = memo(TransferCenterActiveUploadStripRowInner)
