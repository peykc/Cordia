import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, ChevronDown, FolderOpen, Trash2 } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { Button } from './ui/button'
import { FilenameEllipsis } from './FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { openPathInFileExplorer } from '../lib/tauri'
import type { SharedAttachmentItem } from '../lib/tauri'
import type { MediaPreviewState } from '../contexts/MediaPreviewContext'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { cn } from '../lib/utils'
import { ServerReplicationIndicator } from './ServerReplicationIndicator'
import { transferListThumbnailPath } from '../lib/transferListMedia'

export type SeedingGroup = { sha: string; items: SharedAttachmentItem[]; representative: SharedAttachmentItem }

/** Completed upload sessions for this seeding group (from transfer history), newest first. */
export type SeedingDownloaderEntry = {
  requestId: string
  toUserId: string
  serverSigningPubkey?: string
  updatedAt: string
}

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
  downloaderEntries: SeedingDownloaderEntry[]
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
  downloaderEntries,
  setMediaPreview,
  unshareFromServer,
  unshareAttachmentById,
}: Props) {
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  const [dlMenuOpen, setDlMenuOpen] = useState(false)
  const [dlAnchorRect, setDlAnchorRect] = useState<DOMRect | null>(null)
  const dlMenuRef = useRef<HTMLDivElement>(null)
  const dlButtonRef = useRef<HTMLButtonElement>(null)

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setAnchorRect(null)
  }, [])

  const closeDlMenu = useCallback(() => {
    setDlMenuOpen(false)
    setDlAnchorRect(null)
  }, [])

  useEffect(() => {
    if (!menuOpen && !dlMenuOpen) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuOpen) {
        if (!menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) {
          closeMenu()
        }
      }
      if (dlMenuOpen) {
        if (!dlMenuRef.current?.contains(target) && !dlButtonRef.current?.contains(target)) {
          closeDlMenu()
        }
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [menuOpen, dlMenuOpen, closeMenu, closeDlMenu])

  const downloaderUserCount = useMemo(
    () => new Set(downloaderEntries.map((d) => d.toUserId)).size,
    [downloaderEntries]
  )

  const downloaderTitle = useMemo(() => {
    if (downloaderEntries.length === 0) return 'Completed downloads from you'
    const lines = downloaderEntries.map((d) => {
      const name =
        d.toUserId === identity?.user_id
          ? 'You'
          : remoteProfiles.getProfile(d.toUserId)?.display_name?.trim() || `User ${d.toUserId.slice(0, 8)}`
      const srv = d.serverSigningPubkey
        ? serverNameBySigningPubkey.get(d.serverSigningPubkey) ?? `Key ${d.serverSigningPubkey.slice(0, 8)}…`
        : 'Unknown server'
      return `${name} | ${srv}`
    })
    return lines.join('\n')
  }, [downloaderEntries, identity?.user_id, remoteProfiles, serverNameBySigningPubkey])

  const item = group.representative
  const shaTrim = item.sha256?.trim() ?? ''
  const serverKeys = shaTrim ? (serversBySha.get(shaTrim) ?? []) : []
  const serverCount = serverKeys.length
  const tierThumb = transferListThumbnailPath(item.file_name, item.thumbnail_path ?? undefined, item.file_path ?? undefined)

  return (
    <>
      <div className="group flex items-start gap-2 border-b border-border px-2 py-1.5 transition-colors duration-150 hover:bg-muted/50">
        <FileIcon
          fileName={item.file_name}
          attachmentId={item.attachment_id}
          savedPath={item.file_path ?? undefined}
          thumbnailPath={tierThumb}
          boxSize={32}
          squareThumb
          onMediaClick={(url, type, attachmentId, fileName, opts) => {
            const base = {
              attachmentId,
              fileName,
              source: 'transfers' as const,
              originUserId: identity?.user_id ?? '',
              originSentAtIso: item.created_at,
              originDisplayName: identity?.display_name?.trim() || 'You',
              originAvatarDataUrl: profile.avatar_data_url ?? null,
              sizeBytes: item.size_bytes,
              sha256: item.sha256,
            }
            if (type === 'audio') {
              const lp = opts?.localPath?.trim() ?? item.file_path?.trim()
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
              localPath: item.file_path ?? null,
              musicCoverFullSourcePath: opts?.musicCoverFullSourcePath ?? null,
            })
          }}
        />
        <div className="min-w-0 flex-1">
          <FilenameEllipsis
            name={item.file_name}
            className="block h-4 text-[11px] font-medium leading-4"
          />
          <div className="mt-px flex w-max max-w-full min-w-0 shrink-0 items-center gap-1 self-start text-[10px] text-muted-foreground">
            <Button
              ref={dlButtonRef}
              type="button"
              variant="ghost"
              className={cn(
                'h-6 shrink-0 gap-1 rounded-md border px-1.5 text-[10px] font-medium tabular-nums transition-colors',
                dlMenuOpen
                  ? 'border-accent/55 bg-accent/15 text-foreground shadow-sm'
                  : 'border-border/60 bg-muted/25 text-muted-foreground hover:bg-muted/45 hover:text-foreground'
              )}
              title={downloaderTitle}
              aria-expanded={dlMenuOpen}
              aria-haspopup="dialog"
              onClick={(e) => {
                const el = e.currentTarget
                const rect = el.getBoundingClientRect()
                if (dlMenuOpen) {
                  closeDlMenu()
                  return
                }
                setDlAnchorRect(rect)
                setDlMenuOpen(true)
              }}
            >
              <ArrowDownToLine className="h-3 w-3 shrink-0 opacity-90" aria-hidden />
              <span>{downloaderUserCount}</span>
            </Button>
            <span
              className="inline-flex w-[1ch] shrink-0 select-none justify-center font-mono text-xs leading-none text-muted-foreground/80"
              aria-hidden="true"
            >
              |
            </span>
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
        <div
          className={cn(
            'flex min-w-0 shrink-0 items-center gap-0.5 overflow-hidden',
            menuOpen
              ? cn(
                  'pointer-events-auto opacity-100',
                  item.file_path ? 'max-w-[3.75rem]' : 'max-w-[1.75rem]'
                )
              : cn(
                  'pointer-events-none max-w-0 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
                  item.file_path ? 'group-hover:max-w-[3.75rem]' : 'group-hover:max-w-[1.75rem]'
                )
          )}
        >
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

      {dlMenuOpen &&
        dlAnchorRect &&
        createPortal(
          <div
            ref={dlMenuRef}
            className="max-h-[min(240px,50vh)] min-w-[220px] overflow-y-auto overscroll-contain rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg z-[9999]"
            style={{
              position: 'fixed',
              right: window.innerWidth - dlAnchorRect.right,
              top: dlAnchorRect.bottom + 2,
            }}
          >
            <p className="px-2 pb-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              Completed downloads
            </p>
            {downloaderEntries.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground leading-snug">
                No completed downloads recorded for this file yet.
              </p>
            ) : (
              downloaderEntries.map((d) => {
                const displayName =
                  d.toUserId === identity?.user_id
                    ? 'You'
                    : remoteProfiles.getProfile(d.toUserId)?.display_name?.trim() ||
                      `User ${d.toUserId.slice(0, 8)}`
                const serverLabel = d.serverSigningPubkey
                  ? serverNameBySigningPubkey.get(d.serverSigningPubkey) ??
                    `Key ${d.serverSigningPubkey.slice(0, 8)}…`
                  : 'Unknown server'
                return (
                  <div
                    key={d.requestId}
                    className="border-b border-border/40 px-2 py-1.5 text-[11px] last:border-b-0"
                  >
                    <div className="truncate font-medium">{displayName}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground truncate" title={serverLabel}>
                      {serverLabel}
                    </div>
                  </div>
                )
              })
            )}
          </div>,
          document.body
        )}
    </>
  )
})
