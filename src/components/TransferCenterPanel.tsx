import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
} from 'react'

const EMPTY_SIGNING_SET: ReadonlySet<string> = new Set()
import { useVirtualizer } from '@tanstack/react-virtual'
import { Download, FunnelPlus, FunnelX, HardDriveDownload, HardDriveUpload, Upload } from 'lucide-react'
import { useMediaPreview } from '../contexts/MediaPreviewContext'
import { formatBytes } from '../lib/bytes'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { useEphemeralMessagesStore } from '../stores/ephemeralMessagesStore'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useIdentity } from '../contexts/IdentityContext'
import { useServers } from '../contexts/ServersContext'
import {
  TRANSFER_FILTER_OPTIONS,
  type TransferFileFilter,
  fileMatchesTransferFilter,
} from '../lib/transferCenterFilters'
import type { AttachmentTransferState } from '../contexts/EphemeralMessagesContext'
import type { SharedAttachmentItem } from '../lib/tauri'
import { cn } from '../lib/utils'
import { TransferCenterDownloadRow } from './TransferCenterDownloadRow'
import { TransferCenterActiveUploadStripRow } from './TransferCenterActiveUploadStripRow'
import { TransferCenterSeedingRow } from './TransferCenterSeedingRow'

const HISTORY_ROW_H = 48
const SEED_ROW_H = 48
const ACTIVE_STRIP_ROW_H = 48
const ACTIVE_MAX_H_POPUP = 192
const ACTIVE_MAX_H_FULL = 240
/** Stats tiles + active strips + history + seeding section surfaces */
const TRANSFER_SECTION_BAR_BG = 'bg-[hsl(220deg_7%_20%_/_85%)]'

/** Horizontally center the selected pill in the filter strip (clamped; same idea as media gallery thumbs). */
function scrollTransferFilterStripToCenterPill(
  strip: HTMLElement,
  pill: HTMLElement,
  behavior: ScrollBehavior = 'smooth'
) {
  const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth)
  if (maxScroll <= 0) return
  const centerX = pill.offsetLeft + pill.offsetWidth / 2
  const left = Math.max(0, Math.min(centerX - strip.clientWidth / 2, maxScroll))
  strip.scrollTo({ left, behavior })
}

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
        'rounded-lg border border-border/50 px-2.5 py-2 min-w-0',
        TRANSFER_SECTION_BAR_BG,
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
  const stripRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const centerSelected = (behavior: ScrollBehavior) => {
    const strip = stripRef.current
    if (!strip) return
    const pill = strip.querySelector<HTMLElement>(`[data-transfer-filter="${CSS.escape(valueRef.current)}"]`)
    if (pill) scrollTransferFilterStripToCenterPill(strip, pill, behavior)
  }

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => centerSelected('smooth'))
    return () => cancelAnimationFrame(id)
  }, [value])

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => centerSelected('auto'))
    })
    ro.observe(strip)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={stripRef}
      className={cn(
        'relative flex min-w-0 flex-nowrap gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x [scrollbar-width:thin]',
        compact ? 'gap-0.5' : 'gap-1'
      )}
    >
      {TRANSFER_FILTER_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          data-transfer-filter={opt.id}
          onClick={() => onChange(opt.id)}
          className={cn(
            'shrink-0 rounded-md border text-[10px] font-medium transition-colors',
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
  } = useEphemeralMessages()

  const [seedingFilter, setSeedingFilter] = useState<TransferFileFilter>('all')
  const [historyFilter, setHistoryFilter] = useState<TransferFileFilter>('all')
  const [historyFiltersOpen, setHistoryFiltersOpen] = useState(false)
  const [seedingFiltersOpen, setSeedingFiltersOpen] = useState(false)

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

  /** Per content SHA: server signing pubkeys with an active outgoing upload (peer downloading from you). */
  const activeUploadSigningKeysBySha = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const t of attachmentTransfers) {
      if (t.direction !== 'upload') continue
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'rejected') continue
      const sha = t.sha256?.trim()
      const spk = t.server_signing_pubkey?.trim()
      if (!sha || !spk) continue
      let set = map.get(sha)
      if (!set) {
        set = new Set()
        map.set(sha, set)
      }
      set.add(spk)
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

  const activeUploadGroups = useMemo(() => {
    const byAtt = new Map<string, AttachmentTransferState[]>()
    for (const t of attachmentTransfers) {
      if (t.direction !== 'upload') continue
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'rejected') continue
      const list = byAtt.get(t.attachment_id) ?? []
      list.push(t)
      byAtt.set(t.attachment_id, list)
    }
    return Array.from(byAtt.entries())
      .map(([attachmentId, transfers]) => ({ attachmentId, transfers }))
      .sort((a, b) => a.attachmentId.localeCompare(b.attachmentId))
  }, [attachmentTransfers])

  const activeUploadSessionCount = useMemo(
    () => activeUploadGroups.reduce((acc, g) => acc + g.transfers.length, 0),
    [activeUploadGroups]
  )

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
    for (const t of attachmentTransfers) {
      if (t.direction !== 'upload') continue
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'rejected') continue
      const kbps = t.debug_kbps
      if (kbps != null && Number.isFinite(kbps)) sum += Math.max(0, kbps)
    }
    return sum
  }, [attachmentTransfers])

  const activeDownloadsTileSub = useMemo(() => {
    if (activeDownloadRows.length === 0) return undefined
    const parts: string[] = [formatRate(aggregateDownloadKbps)]
    if (queuedRows.length > 0) parts.push(`${queuedRows.length} queued`)
    return parts.join(' · ')
  }, [activeDownloadRows.length, aggregateDownloadKbps, queuedRows.length])

  const activeUploadsTileSub = useMemo(() => {
    if (activeUploadGroups.length === 0) return undefined
    const parts = [formatRate(aggregateUploadKbps)]
    if (activeUploadSessionCount > activeUploadGroups.length) {
      parts.push(`${activeUploadSessionCount} sessions`)
    }
    return parts.join(' · ')
  }, [activeUploadGroups.length, activeUploadSessionCount, aggregateUploadKbps])

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
    const activeUp = activeUploadGroups.length

    return {
      completedCount,
      completedBytes,
      seedingCount: uploadsVisibleBySha.length,
      seedingBytes,
      activeDownloadCount: activeDown,
      activeUploadCount: activeUp,
    }
  }, [downloadRows, liveTransferByRequest, uploadsVisibleBySha, activeDownloadRows.length, activeUploadGroups.length])

  const activeDownloadRequestIdSet = useMemo(
    () => new Set(activeDownloadRows.map((r) => r.request_id)),
    [activeDownloadRows]
  )

  const downloadHistoryForList = useMemo(() => {
    return downloadRows.filter(
      (row) =>
        !activeDownloadRequestIdSet.has(row.request_id) &&
        fileMatchesTransferFilter(row.file_name, historyFilter)
    )
  }, [downloadRows, historyFilter, activeDownloadRequestIdSet])

  const seedingLibraryFiltered = useMemo(() => {
    return uploadsVisibleBySha.filter(({ representative: r }) => fileMatchesTransferFilter(r.file_name, seedingFilter))
  }, [uploadsVisibleBySha, seedingFilter])

  /** Min width so `|` + dots align, without a fixed 11ch “dead zone” when all sizes are short. */
  const seedingSizeColumnCh = useMemo(() => {
    let maxLen = 4
    for (const g of seedingLibraryFiltered) {
      const len = formatBytes(g.representative.size_bytes).length
      if (len > maxLen) maxLen = len
    }
    return Math.min(maxLen + 1, 16)
  }, [seedingLibraryFiltered])

  const historyParentRef = useRef<HTMLDivElement>(null)
  const seedParentRef = useRef<HTMLDivElement>(null)
  const activeDownloadParentRef = useRef<HTMLDivElement>(null)
  const activeUploadParentRef = useRef<HTMLDivElement>(null)

  const activeDownloadVirtualizer = useVirtualizer({
    count: activeDownloadRows.length,
    getScrollElement: () => activeDownloadParentRef.current,
    estimateSize: () => ACTIVE_STRIP_ROW_H,
    overscan: 8,
  })

  const activeUploadVirtualizer = useVirtualizer({
    count: activeUploadGroups.length,
    getScrollElement: () => activeUploadParentRef.current,
    estimateSize: () => ACTIVE_STRIP_ROW_H,
    overscan: 8,
  })

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
        <div className="grid shrink-0 grid-cols-1 gap-2 min-[580px]:grid-cols-2 min-h-0">
          <div className="flex min-h-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
            <div
              className={cn(
                'shrink-0 border-b border-border/40 px-2 py-1 flex items-center justify-between',
                TRANSFER_SECTION_BAR_BG
              )}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Active downloads</span>
              {activeDownloadRows.length > 0 && (
                <span className="text-[10px] tabular-nums text-muted-foreground">{activeDownloadRows.length}</span>
              )}
            </div>
            <div
              ref={activeDownloadParentRef}
              className="min-h-0 overflow-y-auto overscroll-contain"
              style={{ maxHeight: activeMaxH }}
            >
              {activeDownloadRows.length === 0 ? (
                <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">None</p>
              ) : (
                <div
                  className="relative w-full"
                  style={{ height: `${activeDownloadVirtualizer.getTotalSize()}px` }}
                >
                  {activeDownloadVirtualizer.getVirtualItems().map((vi) => {
                    const row = activeDownloadRows[vi.index]
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
                        ref={activeDownloadVirtualizer.measureElement}
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
                          activeStrip
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
          <div className="flex min-h-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
            <div
              className={cn(
                'shrink-0 border-b border-border/40 px-2 py-1 flex items-center justify-between',
                TRANSFER_SECTION_BAR_BG
              )}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Active uploads</span>
              {activeUploadGroups.length > 0 && (
                <span className="text-[10px] tabular-nums text-muted-foreground">{activeUploadGroups.length}</span>
              )}
            </div>
            <div
              ref={activeUploadParentRef}
              className="min-h-0 overflow-y-auto overscroll-contain"
              style={{ maxHeight: activeMaxH }}
            >
              {activeUploadGroups.length === 0 ? (
                <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">None</p>
              ) : (
                <div
                  className="relative w-full"
                  style={{ height: `${activeUploadVirtualizer.getTotalSize()}px` }}
                >
                  {activeUploadVirtualizer.getVirtualItems().map((vi) => {
                    const g = activeUploadGroups[vi.index]
                    if (!g) return null
                    const shared = sharedByAttachmentId.get(g.attachmentId)
                    return (
                      <div
                        key={g.attachmentId}
                        data-index={vi.index}
                        ref={activeUploadVirtualizer.measureElement}
                        className="absolute left-0 top-0 w-full"
                        style={
                          {
                            transform: `translateY(${vi.start}px)`,
                          } as CSSProperties
                        }
                      >
                        <TransferCenterActiveUploadStripRow group={g} shared={shared} />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Split history + library */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 min-[450px]:grid-cols-2 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
            <div className={cn('shrink-0 min-w-0 border-b border-border/40 px-2 py-2', TRANSFER_SECTION_BAR_BG)}>
              <div className="flex min-w-0 items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex w-fit max-w-[calc(100%-2.5rem)] shrink-0 items-center gap-1 rounded-md py-0.5 pl-0.5 pr-1 text-left hover:bg-white/5"
                  aria-expanded={historyFiltersOpen}
                  onClick={() => setHistoryFiltersOpen((o) => !o)}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Download history
                  </span>
                  {historyFiltersOpen ? (
                    <FunnelX
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        historyFilter !== 'all' ? 'text-accent' : 'text-muted-foreground'
                      )}
                      aria-hidden
                    />
                  ) : (
                    <FunnelPlus
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        historyFilter !== 'all' ? 'text-accent' : 'text-muted-foreground'
                      )}
                      aria-hidden
                    />
                  )}
                </button>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {downloadHistoryForList.length}
                </span>
              </div>
              {historyFiltersOpen ? (
                <div className="mt-1.5 min-w-0">
                  <FilterPills value={historyFilter} onChange={setHistoryFilter} compact />
                </div>
              ) : null}
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
                          omitProgressBar
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
            <div className={cn('shrink-0 min-w-0 border-b border-border/40 px-2 py-2', TRANSFER_SECTION_BAR_BG)}>
              <div className="flex min-w-0 items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex w-fit max-w-[calc(100%-2.5rem)] shrink-0 items-center gap-1 rounded-md py-0.5 pl-0.5 pr-1 text-left hover:bg-white/5"
                  aria-expanded={seedingFiltersOpen}
                  onClick={() => setSeedingFiltersOpen((o) => !o)}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Seeding library
                  </span>
                  {seedingFiltersOpen ? (
                    <FunnelX
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        seedingFilter !== 'all' ? 'text-accent' : 'text-muted-foreground'
                      )}
                      aria-hidden
                    />
                  ) : (
                    <FunnelPlus
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        seedingFilter !== 'all' ? 'text-accent' : 'text-muted-foreground'
                      )}
                      aria-hidden
                    />
                  )}
                </button>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {seedingLibraryFiltered.length}
                </span>
              </div>
              {seedingFiltersOpen ? (
                <div className="mt-1.5 min-w-0">
                  <FilterPills value={seedingFilter} onChange={setSeedingFilter} compact />
                </div>
              ) : null}
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
                    const shaKey = group.representative.sha256?.trim() ?? ''
                    const activeSigningForSha =
                      shaKey.length > 0
                        ? (activeUploadSigningKeysBySha.get(shaKey) ?? EMPTY_SIGNING_SET)
                        : EMPTY_SIGNING_SET
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
                          sizeColumnCh={seedingSizeColumnCh}
                          serversBySha={serversBySha}
                          serverNameBySigningPubkey={serverNameBySigningPubkey}
                          activeSigningPubkeys={activeSigningForSha}
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
