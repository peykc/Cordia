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

function directoryForPath(path: string): string {
  const normalized = path.replace(/\//g, '\\')
  const idx = normalized.lastIndexOf('\\')
  return idx > 0 ? normalized.slice(0, idx) : normalized
}

type Props = {
  group: SeedingGroup
  /** List-computed `ch` width: aligns `|` / dots across rows with minimal slack for current filter. */
  sizeColumnCh: number
  serversBySha: Map<string, string[]>
  serverNameBySigningPubkey: Map<string, string>
  /** Servers (signing pubkeys) with an active upload for this content — blue dots in the indicator. */
  activeSigningPubkeys: ReadonlySet<string>
  setMediaPreview: (p: MediaPreviewState) => void
  unshareFromServer: (serverKey: string, sha256: string) => void
  unshareAttachmentById: (attachmentId: string) => void
}

export const TransferCenterSeedingRow = memo(function TransferCenterSeedingRow({
  group,
  sizeColumnCh,
  serversBySha,
  serverNameBySigningPubkey,
  activeSigningPubkeys,
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
          <FilenameEllipsis
            name={item.file_name}
            className="block h-4 text-[11px] font-medium leading-4"
          />
          <div className="mt-px flex w-max max-w-full shrink-0 items-center gap-1.5 self-start text-[10px] text-muted-foreground">
            <span
              className="shrink-0 truncate text-left tabular-nums"
              style={{
                width: `${sizeColumnCh}ch`,
                minWidth: `${sizeColumnCh}ch`,
                maxWidth: `${sizeColumnCh}ch`,
              }}
              title={formatBytes(item.size_bytes)}
            >
              {formatBytes(item.size_bytes)}
            </span>
            <span
              className="inline-flex w-[1ch] shrink-0 select-none justify-center font-mono text-xs leading-none text-muted-foreground/80"
              aria-hidden="true"
            >
              |
            </span>
            <span className="shrink-0">
              <ServerReplicationIndicator
                count={serverCount}
                serverNames={serverKeys.map(
                  (k) => serverNameBySigningPubkey.get(k) ?? `Key ${k.slice(0, 8)}…`
                )}
                serverSigningPubkeys={serverKeys}
                activeSigningPubkeys={activeSigningPubkeys}
              />
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!!item.file_path && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title="Open folder"
              onClick={() => openPathInFileExplorer(directoryForPath(item.file_path!))}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          )}
          <div
            className={cn(
              'flex min-w-0 shrink-0 overflow-hidden',
              menuOpen
                ? 'pointer-events-auto max-w-[1.75rem] opacity-100'
                : 'pointer-events-none max-w-0 opacity-0 group-hover:pointer-events-auto group-hover:max-w-[1.75rem] group-hover:opacity-100'
            )}
          >
            <Button
              ref={menuButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
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
