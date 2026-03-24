import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createPortal } from 'react-dom'
import { ChevronDown, FolderOpen, Trash2 } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { Button } from './ui/button'
import { FilenameEllipsis } from './FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { openPathInFileExplorer } from '../lib/tauri'
import type { SharedAttachmentItem } from '../lib/tauri'
import type { MediaPreviewState } from '../contexts/MediaPreviewContext'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { cn } from '../lib/utils'
import { ServerReplicationIndicator } from './ServerReplicationIndicator'
import { listImageTierThumbnailPath } from '../lib/transferListMedia'

export type SeedingGroup = { sha: string; items: SharedAttachmentItem[]; representative: SharedAttachmentItem }

export type LiveUpload = {
  status: string
  progress: number
  debugKbps?: number
  etaSeconds?: number
  bufferedBytes?: number
}

function directoryForPath(path: string): string {
  const normalized = path.replace(/\//g, '\\')
  const idx = normalized.lastIndexOf('\\')
  return idx > 0 ? normalized.slice(0, idx) : normalized
}

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

type Props = {
  group: SeedingGroup
  serversBySha: Map<string, string[]>
  serverNameBySigningPubkey: Map<string, string>
  live?: LiveUpload | null
  setMediaPreview: (p: MediaPreviewState) => void
  unshareFromServer: (serverKey: string, sha256: string) => void
  unshareAttachmentById: (attachmentId: string) => void
}

export const TransferCenterSeedingRow = memo(function TransferCenterSeedingRow({
  group,
  serversBySha,
  serverNameBySigningPubkey,
  live,
  setMediaPreview,
  unshareFromServer,
  unshareAttachmentById,
}: Props) {
  const { identity } = useIdentity()
  const { profile } = useProfile()
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

  const item = group.representative
  const shaTrim = item.sha256?.trim() ?? ''
  const serverKeys = shaTrim ? (serversBySha.get(shaTrim) ?? []) : []
  const serverCount = serverKeys.length
  const tierThumb = listImageTierThumbnailPath(item.thumbnail_path ?? undefined, item.file_path ?? undefined)
  const p =
    live?.status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round((live?.progress ?? 0) * 100)))
  const showBar = !!live && (live.status === 'transferring' || live.status === 'completed')

  return (
    <>
      <div className="group flex items-start gap-2 border-b border-border px-2 py-1.5 transition-colors duration-150 hover:bg-muted/50">
        <FileIcon
          fileName={item.file_name}
          attachmentId={item.can_share_now && !item.file_path ? item.attachment_id : null}
          savedPath={item.file_path ?? undefined}
          thumbnailPath={tierThumb}
          boxSize={32}
          squareThumb
          onMediaClick={(url, type, attachmentId, fileName) =>
            setMediaPreview({
              type,
              url,
              attachmentId,
              fileName,
              source: 'transfers',
              originUserId: identity?.user_id ?? '',
              originSentAtIso: item.created_at,
              originDisplayName: identity?.display_name?.trim() || 'You',
              originAvatarDataUrl: profile.avatar_data_url ?? null,
              localPath: item.file_path ?? null,
              sizeBytes: item.size_bytes,
              sha256: item.sha256,
            })
          }
        />
        <div className="min-w-0 flex-1">
          <FilenameEllipsis name={item.file_name} className="block text-[11px] font-medium leading-4" />
          <div className="text-[10px] text-muted-foreground flex w-full min-w-0 items-center gap-1.5 flex-wrap">
            <span className="shrink-0">{formatBytes(item.size_bytes)}</span>
            <span className="text-border/60 shrink-0">·</span>
            <ServerReplicationIndicator
              count={serverCount}
              serverNames={serverKeys.map(
                (k) => serverNameBySigningPubkey.get(k) ?? `Key ${k.slice(0, 8)}…`
              )}
            />
          </div>
          {showBar && (
            <div className="mt-0.5 h-0.5 max-w-[200px] rounded-full bg-foreground/10 overflow-hidden">
              <div
                className={cn('h-full rounded-full', live?.status === 'completed' ? 'bg-emerald-500/80' : 'bg-violet-500/70')}
                style={{ width: `${Math.max(2, p)}%` }}
              />
            </div>
          )}
          {!!live &&
            (live.status === 'requesting' || live.status === 'connecting' || live.status === 'transferring') && (
              <div className="text-[9px] text-muted-foreground mt-0.5 space-x-1">
                <span>{formatRate(live.debugKbps)}</span>
                <span>·</span>
                <span>ETA {formatEta(live.etaSeconds)}</span>
                {live.bufferedBytes != null && live.bufferedBytes > 64 * 1024 && (
                  <span>· {formatBuffer(live.bufferedBytes)}</span>
                )}
              </div>
            )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!!item.file_path && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100"
              onClick={() => openPathInFileExplorer(directoryForPath(item.file_path!))}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            ref={menuButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 opacity-0 group-hover:opacity-100"
            title="Seeding options"
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
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {menuOpen &&
        anchorRect &&
        createPortal(
          <div
            ref={menuRef}
            className="min-w-[180px] py-1 rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[9999]"
            style={{
              position: 'fixed',
              right: window.innerWidth - anchorRect.right,
              top: anchorRect.bottom + 2,
            }}
          >
            {serverKeys.map((serverKey) => {
              const isLastServer = serverKeys.length === 1
              return (
                <button
                  key={serverKey}
                  type="button"
                  className="w-full px-2 py-1.5 text-left text-[11px] hover:bg-white/5 truncate"
                  onClick={() => {
                    if (isLastServer) {
                      unshareAttachmentById(item.attachment_id)
                    } else {
                      flushSync(() => {
                        unshareFromServer(serverKey, shaTrim || item.sha256)
                      })
                    }
                    closeMenu()
                  }}
                >
                  Remove from server ({serverNameBySigningPubkey.get(serverKey) ?? `${serverKey.slice(0, 8)}…`})
                </button>
              )
            })}
            <button
              type="button"
              className="w-full px-2 py-1.5 text-left text-[11px] text-red-600 hover:bg-red-500/10 flex items-center gap-1.5"
              onClick={() => {
                unshareAttachmentById(item.attachment_id)
                closeMenu()
              }}
            >
              <Trash2 className="h-3 w-3 shrink-0" />
              Unshare everywhere
            </button>
          </div>,
          document.body
        )}
    </>
  )
})
