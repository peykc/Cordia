import { memo, useMemo, useRef, useState, type CSSProperties, type ComponentType } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Download, HardDriveDownload, HardDriveUpload, Upload } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { useMediaPreview } from '../contexts/MediaPreviewContext'
import { FilenameEllipsis } from './FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { useEphemeralMessagesStore } from '../stores/ephemeralMessagesStore'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { useServers } from '../contexts/ServersContext'
import { listImageTierThumbnailPath } from '../lib/transferListMedia'
import {
  TRANSFER_FILTER_OPTIONS,
  type TransferFileFilter,
  fileMatchesTransferFilter,
} from '../lib/transferCenterFilters'
import type { AttachmentTransferState } from '../contexts/EphemeralMessagesContext'
import type { SharedAttachmentItem } from '../lib/tauri'
import { cn } from '../lib/utils'
import { TransferCenterDownloadRow } from './TransferCenterDownloadRow'
import { TransferCenterSeedingRow, type LiveUpload } from './TransferCenterSeedingRow'

const HISTORY_ROW_H = 56
const SEED_ROW_H = 58
const ACTIVE_MAX_H_POPUP = 132
const ACTIVE_MAX_H_FULL = 168

function formatRate(kbps?: number): string {
  const safe = Math.max(0, kbps ?? 0)
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} MB/s`
  return `${Math.round(safe)} KB/s`
}

export type TransferCenterVariant = 'popup' | 'full'

/** Merge duplicate `sharedAttachments` rows (same attachment_id) and prefer populated SHA / paths. */
function mergeSharedAttachment(prev: SharedAttachmentItem, next: SharedAttachmentItem): SharedAttachmentItem {
  const shaP = prev.sha256?.trim() ?? ''
  const shaN = next.sha256?.trim() ?? ''
  return {
    ...prev,
    ...next,
    sha256: shaN || shaP || prev.sha256 || next.sha256,
    file_path: prev.file_path || next.file_path,
    thumbnail_path: prev.thumbnail_path || next.thumbnail_path,
    can_share_now: prev.can_share_now || next.can_share_now,
  }
}

function pickSeedingRepresentative(items: SharedAttachmentItem[]): SharedAttachmentItem {
  return (
    items.find((i) => i.file_path) ??
    items.find((i) => (i.sha256?.trim()?.length ?? 0) > 0) ??
    items[0]!
  )
}

const StatTile = memo(function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  className,
}: {
  label: string
  value: string
  sub?: string
  icon: ComponentType<{ className?: string }>
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/50 bg-muted/40 px-2.5 py-2 min-w-0',
        'shadow-sm',
        className
      )}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 bg-background/60">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground truncate">{label}</p>
          <p className="text-sm font-semibold tabular-nums text-foreground truncate leading-tight mt-0.5">{value}</p>
          {sub ? <p className="text-[10px] text-muted-foreground truncate mt-0.5">{sub}</p> : null}
        </div>
      </div>
    </div>
  )
})

const FilterPills = memo(function FilterPills({
  value,
  onChange,
  compact,
}: {
  value: TransferFileFilter
  onChange: (f: TransferFileFilter) => void
  compact?: boolean
}) {
  return (
    <div className={cn('flex flex-wrap gap-1', compact ? 'gap-0.5' : 'gap-1')}>
      {TRANSFER_FILTER_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={cn(
            'rounded-md border text-[10px] font-medium transition-colors',
            compact ? 'px-1.5 py-0.5' : 'px-2 py-1',
            value === opt.id
              ? 'border-accent/60 bg-accent/15 text-foreground'
              : 'border-border/50 bg-background/40 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
})

export function TransferCenterPanel({ variant = 'full' }: { variant?: TransferCenterVariant }) {
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const attachmentTransfers = useEphemeralMessagesStore((s) => s.attachmentTransfers)
  const transferHistory = useEphemeralMessagesStore((s) => s.transferHistory)
  const sharedAttachments = useEphemeralMessagesStore((s) => s.sharedAttachments)
  const serverSharedSha = useEphemeralMessagesStore((s) => s.serverSharedSha)

  /** Inverted index: O(1) lookup per row instead of scanning every server × SHA list. */
  const serversBySha = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [serverKey, shas] of Object.entries(serverSharedSha)) {
      if (!Array.isArray(shas)) continue
      for (const sha of shas) {
        const norm = typeof sha === 'string' ? sha.trim() : ''
        if (!norm) continue
        const list = map.get(norm)
        if (list) list.push(serverKey)
        else map.set(norm, [serverKey])
      }
    }
    return map
  }, [serverSharedSha])
  const { setMediaPreview } = useMediaPreview()
  const { servers } = useServers()
  const {
    unshareFromServer,
    removeTransferHistoryEntry,
    cancelTransferRequest,
    unshareAttachmentById,
    findMessageById,
  } = useEphemeralMessages()

  const [seedingFilter, setSeedingFilter] = useState<TransferFileFilter>('all')
  const [historyFilter, setHistoryFilter] = useState<TransferFileFilter>('all')

  const serverNameBySigningPubkey = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of servers) map.set(s.signing_pubkey, s.name)
    return map
  }, [servers])

  const liveTransferByRequest = useMemo(() => {
    const map = new Map<string, AttachmentTransferState>()
    for (const t of attachmentTransfers) map.set(t.request_id, t)
    return map
  }, [attachmentTransfers])

  const latestUploadByAttachment = useMemo(() => {
    const map = new Map<string, LiveUpload>()
    for (const t of attachmentTransfers) {
      if (t.direction !== 'upload') continue
      map.set(t.attachment_id, {
        status: t.status,
        progress: t.progress,
        debugKbps: t.debug_kbps,
        etaSeconds: t.debug_eta_seconds,
        bufferedBytes: t.debug_buffered_bytes,
      })
    }
    return map
  }, [attachmentTransfers])

  const downloadRows = useMemo(
    () =>
      transferHistory
        .filter((h) => h.direction === 'download')
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [transferHistory]
  )

  const downloadingRows = useMemo(
    () =>
      downloadRows.filter((row) => {
        const s = liveTransferByRequest.get(row.request_id)?.status ?? row.status
        return s === 'requesting' || s === 'connecting' || s === 'transferring'
      }),
    [downloadRows, liveTransferByRequest]
  )

  const queuedRows = useMemo(
    () =>
      downloadRows.filter((row) => {
        const s = liveTransferByRequest.get(row.request_id)?.status ?? row.status
        return s === 'queued'
      }),
    [downloadRows, liveTransferByRequest]
  )

  const activeDownloadRows = useMemo(() => [...queuedRows, ...downloadingRows], [queuedRows, downloadingRows])

  const activeUploadRows = useMemo(() => {
    const out: { attachmentId: string; transfer: AttachmentTransferState }[] = []
    const seen = new Set<string>()
    for (const t of attachmentTransfers) {
      if (t.direction !== 'upload') continue
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'rejected') continue
      if (seen.has(t.attachment_id)) continue
      seen.add(t.attachment_id)
      out.push({ attachmentId: t.attachment_id, transfer: t })
    }
    return out
  }, [attachmentTransfers])

  /** Sum of per-transfer rates (KB/s) for active downloads / uploads — shown on dashboard tiles. */
  const aggregateDownloadKbps = useMemo(() => {
    let sum = 0
    for (const row of activeDownloadRows) {
      const kbps = liveTransferByRequest.get(row.request_id)?.debug_kbps
      if (kbps != null && Number.isFinite(kbps)) sum += Math.max(0, kbps)
    }
    return sum
  }, [activeDownloadRows, liveTransferByRequest])

  const aggregateUploadKbps = useMemo(() => {
    let sum = 0
    for (const { transfer } of activeUploadRows) {
      const kbps = transfer.debug_kbps
      if (kbps != null && Number.isFinite(kbps)) sum += Math.max(0, kbps)
    }
    return sum
  }, [activeUploadRows])

  const activeDownloadsTileSub = useMemo(() => {
    if (activeDownloadRows.length === 0) return undefined
    const parts: string[] = [formatRate(aggregateDownloadKbps)]
    if (queuedRows.length > 0) parts.push(`${queuedRows.length} queued`)
    return parts.join(' · ')
  }, [activeDownloadRows.length, aggregateDownloadKbps, queuedRows.length])

  const activeUploadsTileSub = useMemo(() => {
    if (activeUploadRows.length === 0) return undefined
    return `${formatRate(aggregateUploadKbps)} · ${activeUploadRows.length} active`
  }, [activeUploadRows.length, aggregateUploadKbps])

  /** O(1) lookup for active uploads strip + single source for SHA grouping dedupe. */
  const sharedByAttachmentId = useMemo(() => {
    const map = new Map<string, SharedAttachmentItem>()
    for (const item of sharedAttachments) {
      const prev = map.get(item.attachment_id)
      if (!prev) map.set(item.attachment_id, item)
      else map.set(item.attachment_id, mergeSharedAttachment(prev, item))
    }
    return map
  }, [sharedAttachments])

  /**
   * Collapse by content SHA when known; otherwise one row per attachment_id (`__att:…`).
   */
  const uploadsGroupedBySha = useMemo(() => {
    const unique = [...sharedByAttachmentId.values()]

    const byGroupKey = new Map<string, SharedAttachmentItem[]>()
    for (const item of unique) {
      const shaTrim = item.sha256?.trim() ?? ''
      const key = shaTrim.length > 0 ? shaTrim : `__att:${item.attachment_id}`
      const list = byGroupKey.get(key) ?? []
      if (!list.some((x) => x.attachment_id === item.attachment_id)) {
        list.push(item)
      }
      byGroupKey.set(key, list)
    }
    return Array.from(byGroupKey.entries()).map(([sha, items]) => ({
      sha,
      items,
      representative: pickSeedingRepresentative(items),
    }))
  }, [sharedByAttachmentId])

  const uploadsVisibleBySha = useMemo(
    () =>
      uploadsGroupedBySha.filter(({ representative }) => {
        const sha = representative.sha256?.trim() ?? ''
        if (!sha) return false
        return (serversBySha.get(sha)?.length ?? 0) > 0
      }),
    [uploadsGroupedBySha, serversBySha]
  )

  const dashboardStats = useMemo(() => {
    let completedCount = 0
    let completedBytes = 0
    for (const h of downloadRows) {
      const s = liveTransferByRequest.get(h.request_id)?.status ?? h.status
      if (s === 'completed' && h.is_inaccessible !== true) {
        completedCount += 1
        completedBytes += Number(h.size_bytes ?? 0)
      }
    }

    let seedingBytes = 0
    for (const { representative: r } of uploadsVisibleBySha) {
      seedingBytes += Number(r.size_bytes ?? 0)
    }

    const activeDown = activeDownloadRows.length
    const activeUp = activeUploadRows.length

    return {
      completedCount,
      completedBytes,
      seedingCount: uploadsVisibleBySha.length,
      seedingBytes,
      activeDownloadCount: activeDown,
      activeUploadCount: activeUp,
    }
  }, [downloadRows, liveTransferByRequest, uploadsVisibleBySha, activeDownloadRows.length, activeUploadRows.length])

  const downloadHistoryForList = useMemo(() => {
    return downloadRows.filter((row) => fileMatchesTransferFilter(row.file_name, historyFilter))
  }, [downloadRows, historyFilter])

  const seedingLibraryFiltered = useMemo(() => {
    return uploadsVisibleBySha.filter(({ representative: r }) => fileMatchesTransferFilter(r.file_name, seedingFilter))
  }, [uploadsVisibleBySha, seedingFilter])

  const historyParentRef = useRef<HTMLDivElement>(null)
  const seedParentRef = useRef<HTMLDivElement>(null)

  const historyVirtualizer = useVirtualizer({
    count: downloadHistoryForList.length,
    getScrollElement: () => historyParentRef.current,
    estimateSize: () => HISTORY_ROW_H,
    overscan: 12,
  })

  const seedVirtualizer = useVirtualizer({
    count: seedingLibraryFiltered.length,
    getScrollElement: () => seedParentRef.current,
    estimateSize: () => SEED_ROW_H,
    overscan: 10,
  })

  const activeMaxH = variant === 'full' ? ACTIVE_MAX_H_FULL : ACTIVE_MAX_H_POPUP

  const rootClass = variant === 'full' ? 'h-full min-h-0' : 'h-full min-h-0 max-h-full'

  return (
    <>
      <div className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-hidden', rootClass)}>
        {/* Stats dashboard */}
        <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Downloaded"
            value={String(dashboardStats.completedCount)}
            sub={formatBytes(dashboardStats.completedBytes)}
            icon={HardDriveDownload}
          />
          <StatTile
            label="Active Downloads"
            value={String(dashboardStats.activeDownloadCount)}
            sub={activeDownloadsTileSub}
            icon={Download}
          />
          <StatTile
            label="Seeding"
            value={String(dashboardStats.seedingCount)}
            sub={formatBytes(dashboardStats.seedingBytes)}
            icon={HardDriveUpload}
          />
          <StatTile
            label="Active Uploads"
            value={String(dashboardStats.activeUploadCount)}
            sub={activeUploadsTileSub}
            icon={Upload}
          />
        </div>

        {/* Active strips */}
        <div className="grid shrink-0 grid-cols-1 gap-2 md:grid-cols-2 min-h-0">
          <div className="flex min-h-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
            <div className="shrink-0 border-b border-border/40 px-2 py-1 flex items-center justify-between bg-muted/40">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Active downloads</span>
              {activeDownloadRows.length > 0 && (
                <span className="text-[10px] tabular-nums text-muted-foreground">{activeDownloadRows.length}</span>
              )}
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain" style={{ maxHeight: activeMaxH }}>
              {activeDownloadRows.length === 0 ? (
                <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">None</p>
              ) : (
                activeDownloadRows.map((row) => {
                  const live = liveTransferByRequest.get(row.request_id)
                  const fromLabel =
                    row.from_user_id === identity?.user_id
                      ? 'You'
                      : remoteProfiles.getProfile(row.from_user_id)?.display_name?.trim() ||
                        `User ${row.from_user_id.slice(0, 8)}`
                  return (
                    <TransferCenterDownloadRow
                      key={row.request_id}
                      row={row}
                      compact
                      status={live?.status ?? row.status}
                      progress={live?.progress ?? row.progress}
                      debugKbps={live?.debug_kbps}
                      debugEtaSeconds={live?.debug_eta_seconds}
                      debugPendingBytes={live?.debug_pending_bytes}
                      fromLabel={fromLabel}
                      setMediaPreview={setMediaPreview}
                      cancelTransferRequest={cancelTransferRequest}
                      removeTransferHistoryEntry={removeTransferHistoryEntry}
                    />
                  )
                })
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
            <div className="shrink-0 border-b border-border/40 px-2 py-1 flex items-center justify-between bg-muted/40">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Active uploads</span>
              {activeUploadRows.length > 0 && (
                <span className="text-[10px] tabular-nums text-muted-foreground">{activeUploadRows.length}</span>
              )}
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain" style={{ maxHeight: activeMaxH }}>
              {activeUploadRows.length === 0 ? (
                <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">None</p>
              ) : (
                activeUploadRows.map(({ attachmentId, transfer }) => {
                  const shared = sharedByAttachmentId.get(attachmentId)
                  const fileName = shared?.file_name ?? transfer.file_name
                  const p = Math.max(0, Math.min(100, Math.round((transfer.progress ?? 0) * 100)))
                  return (
                    <div
                      key={attachmentId}
                      className="flex items-center gap-2 border-b border-border px-2 py-1 transition-colors duration-150 hover:bg-muted/50"
                    >
                      <FileIcon
                        fileName={fileName}
                        attachmentId={shared?.can_share_now && !shared.file_path ? shared.attachment_id : null}
                        savedPath={shared?.file_path ?? undefined}
                        thumbnailPath={listImageTierThumbnailPath(shared?.thumbnail_path ?? undefined, shared?.file_path ?? undefined)}
                        boxSize={28}
                        squareThumb
                        onMediaClick={(url, type, aid, fn) => {
                          const uid = transfer.from_user_id
                          const isYou = uid === identity?.user_id
                          const rp = remoteProfiles.getProfile(uid)
                          const sentAt = findMessageById(transfer.message_id)?.sent_at ?? new Date().toISOString()
                          setMediaPreview({
                            type,
                            url,
                            attachmentId: aid,
                            fileName: fn ?? fileName,
                            source: 'transfers',
                            originUserId: uid,
                            originSentAtIso: sentAt,
                            originDisplayName: isYou
                              ? identity?.display_name ?? 'You'
                              : rp?.display_name?.trim() || `User ${uid.slice(0, 8)}`,
                            originAvatarDataUrl: isYou ? profile.avatar_data_url ?? null : rp?.avatar_data_url ?? null,
                            localPath: shared?.file_path ?? null,
                            sizeBytes: shared?.size_bytes,
                            sha256: shared?.sha256 ?? transfer.sha256,
                          })
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <FilenameEllipsis name={fileName} className="text-[11px] font-medium" />
                        <div className="h-0.5 mt-1 max-w-[160px] rounded-full bg-foreground/10 overflow-hidden">
                          <div className="h-full bg-violet-500/70 rounded-full" style={{ width: `${Math.max(3, p)}%` }} />
                        </div>
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground w-8">{p}%</span>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {/* Split history + library */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 md:grid-cols-2 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
            <div className="shrink-0 space-y-1.5 border-b border-border/40 bg-muted/10 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Download history</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{downloadHistoryForList.length}</span>
              </div>
              <FilterPills value={historyFilter} onChange={setHistoryFilter} compact />
            </div>
            <div ref={historyParentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {downloadHistoryForList.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">No entries</p>
              ) : (
                <div
                  className="relative w-full"
                  style={{ height: `${historyVirtualizer.getTotalSize()}px` }}
                >
                  {historyVirtualizer.getVirtualItems().map((vi) => {
                    const row = downloadHistoryForList[vi.index]
                    if (!row) return null
                    const live = liveTransferByRequest.get(row.request_id)
                    const fromLabel =
                      row.from_user_id === identity?.user_id
                        ? 'You'
                        : remoteProfiles.getProfile(row.from_user_id)?.display_name?.trim() ||
                          `User ${row.from_user_id.slice(0, 8)}`
                    return (
                      <div
                        key={row.request_id}
                        data-index={vi.index}
                        ref={historyVirtualizer.measureElement}
                        className="absolute left-0 top-0 w-full"
                        style={
                          {
                            transform: `translateY(${vi.start}px)`,
                          } as CSSProperties
                        }
                      >
                        <TransferCenterDownloadRow
                          row={row}
                          compact={false}
                          status={live?.status ?? row.status}
                          progress={live?.progress ?? row.progress}
                          debugKbps={live?.debug_kbps}
                          debugEtaSeconds={live?.debug_eta_seconds}
                          debugPendingBytes={live?.debug_pending_bytes}
                          fromLabel={fromLabel}
                          setMediaPreview={setMediaPreview}
                          cancelTransferRequest={cancelTransferRequest}
                          removeTransferHistoryEntry={removeTransferHistoryEntry}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
            <div className="shrink-0 space-y-1.5 border-b border-border/40 bg-muted/10 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Seeding library</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{seedingLibraryFiltered.length}</span>
              </div>
              <FilterPills value={seedingFilter} onChange={setSeedingFilter} compact />
            </div>
            <div ref={seedParentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {seedingLibraryFiltered.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                  {uploadsVisibleBySha.length === 0 ? 'Nothing shared in any server' : 'No matches for filter'}
                </p>
              ) : (
                <div
                  className="relative w-full"
                  style={{ height: `${seedVirtualizer.getTotalSize()}px` }}
                >
                  {seedVirtualizer.getVirtualItems().map((vi) => {
                    const group = seedingLibraryFiltered[vi.index]
                    if (!group) return null
                    return (
                      <div
                        key={group.sha}
                        data-index={vi.index}
                        ref={seedVirtualizer.measureElement}
                        className="absolute left-0 top-0 w-full"
                        style={
                          {
                            transform: `translateY(${vi.start}px)`,
                          } as CSSProperties
                        }
                      >
                        <TransferCenterSeedingRow
                          group={group}
                          serversBySha={serversBySha}
                          serverNameBySigningPubkey={serverNameBySigningPubkey}
                          live={latestUploadByAttachment.get(group.representative.attachment_id) ?? null}
                          setMediaPreview={setMediaPreview}
                          unshareFromServer={unshareFromServer}
                          unshareAttachmentById={unshareAttachmentById}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
