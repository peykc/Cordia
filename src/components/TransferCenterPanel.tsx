import { memo, useCallback, useMemo, useRef, useState, type CSSProperties, type ComponentType } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Download, HardDriveDownload, HardDriveUpload, Upload } from 'lucide-react'
import { useMediaPreview } from '../contexts/MediaPreviewContext'
import { formatBytes } from '../lib/bytes'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { useEphemeralMessagesStore } from '../stores/ephemeralMessagesStore'
import {
  selectActiveDownloadQueuedCount,
  selectAggregateActiveDownloadKbps,
  selectAggregateActiveUploadKbps,
  selectActiveUploadSessionCount,
} from '../domain/transfers/selectors'
import {
  buildActiveUploadGroups,
  selectActiveDownloadRequestIdsSig,
  selectActiveUploadGroupKeysSig,
  selectUploadActiveLayoutSig,
} from '../lib/transferCenterSelectors'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useIdentity } from '../contexts/IdentityContext'
import { useServers } from '../contexts/ServersContext'
import { type TransferFileFilter, fileMatchesTransferFilter } from '../lib/transferCenterFilters'
import type { SharedAttachmentItem } from '../lib/tauri'
import { cn } from '../lib/utils'
import { TransferCenterDownloadRow } from './TransferCenterDownloadRow'
import { TransferCenterActiveUploadStripRow } from './TransferCenterActiveUploadStripRow'
import { type SeedingDownloaderEntry } from './TransferCenterSeedingRow'
import {
  TransferCenterDownloadHistoryPane,
  TransferCenterSeedingLibraryPane,
} from './TransferCenterHistorySeedingPanes'

const ACTIVE_STRIP_ROW_H = 48
const ACTIVE_MAX_H_POPUP = 192
const ACTIVE_MAX_H_FULL = 240
const TRANSFER_SECTION_BAR_BG = 'bg-[hsl(220deg_7%_20%_/_85%)]'

function formatRate(kbps?: number): string {
  const safe = Math.max(0, kbps ?? 0)
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} MB/s`
  return `${Math.round(safe)} KB/s`
}

export type TransferCenterVariant = 'popup' | 'full'

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

const ActiveDownloadsStatTile = memo(function ActiveDownloadsStatTile({ count }: { count: number }) {
  const aggregateKbps = useEphemeralMessagesStore(selectAggregateActiveDownloadKbps)
  const queuedCount = useEphemeralMessagesStore(selectActiveDownloadQueuedCount)
  const sub = useMemo(() => {
    if (count === 0) return undefined
    const parts: string[] = [formatRate(aggregateKbps)]
    if (queuedCount > 0) parts.push(`${queuedCount} queued`)
    return parts.join(' · ')
  }, [aggregateKbps, count, queuedCount])

  return <StatTile label="Active Downloads" value={String(count)} sub={sub} icon={Download} />
})

const ActiveUploadsStatTile = memo(function ActiveUploadsStatTile({ groupCount }: { groupCount: number }) {
  const aggregateKbps = useEphemeralMessagesStore(selectAggregateActiveUploadKbps)
  const sessionCount = useEphemeralMessagesStore(selectActiveUploadSessionCount)
  const sub = useMemo(() => {
    if (groupCount === 0) return undefined
    const parts = [formatRate(aggregateKbps)]
    if (sessionCount > groupCount) parts.push(`${sessionCount} sessions`)
    return parts.join(' · ')
  }, [aggregateKbps, groupCount, sessionCount])

  return <StatTile label="Active Uploads" value={String(groupCount)} sub={sub} icon={Upload} />
})

export function TransferCenterPanel({ variant = 'full' }: { variant?: TransferCenterVariant }) {
  const { identity } = useIdentity()
  const remoteProfiles = useRemoteProfiles()
  const transferHistory = useEphemeralMessagesStore((s) => s.transferHistory)
  const sharedAttachments = useEphemeralMessagesStore((s) => s.sharedAttachments)
  const serverSharedSha = useEphemeralMessagesStore((s) => s.serverSharedSha)
  const uploadLayoutSig = useEphemeralMessagesStore(selectUploadActiveLayoutSig)
  const activeDownloadRequestIdsSig = useEphemeralMessagesStore(selectActiveDownloadRequestIdsSig)
  const activeUploadGroupKeysSig = useEphemeralMessagesStore(selectActiveUploadGroupKeysSig)

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
  const { unshareFromServer, removeTransferHistoryEntry, cancelTransferRequest, unshareAttachmentById } =
    useEphemeralMessages()

  const [seedingFilter, setSeedingFilter] = useState<TransferFileFilter>('all')
  const [historyFilter, setHistoryFilter] = useState<TransferFileFilter>('all')
  const [historyFiltersOpen, setHistoryFiltersOpen] = useState(false)
  const [seedingFiltersOpen, setSeedingFiltersOpen] = useState(false)

  const serverNameBySigningPubkey = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of servers) map.set(s.signing_pubkey, s.name)
    return map
  }, [servers])

  const activeUploadSigningKeysBySha = useMemo(() => {
    const map = new Map<string, Set<string>>()
    const state = useEphemeralMessagesStore.getState()
    for (const id of state.activeUploadIds) {
      const t = state.transfersByRequestId[id]
      if (!t || t.direction !== 'upload') continue
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
  }, [uploadLayoutSig])

  const downloadRows = useMemo(
    () =>
      transferHistory
        .filter((h) => h.direction === 'download')
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [transferHistory]
  )

  const activeDownloadRequestIdSet = useMemo(() => {
    if (!activeDownloadRequestIdsSig) return new Set<string>()
    return new Set(activeDownloadRequestIdsSig.split('\0'))
  }, [activeDownloadRequestIdsSig])

  const activeDownloadRows = useMemo(
    () => downloadRows.filter((row) => activeDownloadRequestIdSet.has(row.request_id)),
    [downloadRows, activeDownloadRequestIdSet]
  )

  const activeUploadGroups = useMemo(
    () => buildActiveUploadGroups(useEphemeralMessagesStore.getState()),
    [activeUploadGroupKeysSig]
  )

  const sharedByAttachmentId = useMemo(() => {
    const map = new Map<string, SharedAttachmentItem>()
    for (const item of sharedAttachments) {
      const prev = map.get(item.attachment_id)
      if (!prev) map.set(item.attachment_id, item)
      else map.set(item.attachment_id, mergeSharedAttachment(prev, item))
    }
    return map
  }, [sharedAttachments])

  const uploadsGroupedBySha = useMemo(() => {
    const unique = [...sharedByAttachmentId.values()]
    const byGroupKey = new Map<string, SharedAttachmentItem[]>()
    for (const item of unique) {
      const shaTrim = item.sha256?.trim() ?? ''
      const key = shaTrim.length > 0 ? shaTrim : `__att:${item.attachment_id}`
      const list = byGroupKey.get(key) ?? []
      if (!list.some((x) => x.attachment_id === item.attachment_id)) list.push(item)
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

  const attachmentIdToSeedingGroupSha = useMemo(() => {
    const m = new Map<string, string>()
    for (const { sha, items } of uploadsGroupedBySha) {
      for (const it of items) m.set(it.attachment_id, sha)
    }
    return m
  }, [uploadsGroupedBySha])

  const seedingDownloadersByGroupSha = useMemo(() => {
    const map = new Map<string, SeedingDownloaderEntry[]>()
    for (const h of transferHistory) {
      if (h.direction !== 'upload' || h.status !== 'completed') continue
      const shaKey = attachmentIdToSeedingGroupSha.get(h.attachment_id)
      if (!shaKey) continue
      const row: SeedingDownloaderEntry = {
        requestId: h.request_id,
        toUserId: h.to_user_id,
        serverSigningPubkey: h.server_signing_pubkey,
        updatedAt: h.updated_at,
      }
      const list = map.get(shaKey) ?? []
      list.push(row)
      map.set(shaKey, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    }
    return map
  }, [transferHistory, attachmentIdToSeedingGroupSha])

  const dashboardStats = useMemo(() => {
    let completedCount = 0
    let completedBytes = 0
    for (const h of downloadRows) {
      if (h.status === 'completed' && h.is_inaccessible !== true) {
        completedCount += 1
        completedBytes += Number(h.size_bytes ?? 0)
      }
    }

    let seedingBytes = 0
    for (const { representative: r } of uploadsVisibleBySha) {
      seedingBytes += Number(r.size_bytes ?? 0)
    }

    return {
      completedCount,
      completedBytes,
      seedingCount: uploadsVisibleBySha.length,
      seedingBytes,
      activeDownloadCount: activeDownloadRows.length,
      activeUploadCount: activeUploadGroups.length,
    }
  }, [downloadRows, uploadsVisibleBySha, activeDownloadRows.length, activeUploadGroups.length])

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

  const seedingSizeColumnCh = useMemo(() => {
    let maxLen = 4
    for (const g of seedingLibraryFiltered) {
      const len = formatBytes(g.representative.size_bytes).length
      if (len > maxLen) maxLen = len
    }
    return Math.min(maxLen + 1, 16)
  }, [seedingLibraryFiltered])

  const activeDownloadParentRef = useRef<HTMLDivElement>(null)
  const activeUploadParentRef = useRef<HTMLDivElement>(null)
  const getActiveDownloadScrollElement = useCallback(() => activeDownloadParentRef.current, [])
  const getActiveUploadScrollElement = useCallback(() => activeUploadParentRef.current, [])

  const activeDownloadVirtualizer = useVirtualizer({
    count: activeDownloadRows.length,
    getScrollElement: getActiveDownloadScrollElement,
    estimateSize: () => ACTIVE_STRIP_ROW_H,
    overscan: 5,
    useFlushSync: false,
  })

  const activeUploadVirtualizer = useVirtualizer({
    count: activeUploadGroups.length,
    getScrollElement: getActiveUploadScrollElement,
    estimateSize: () => ACTIVE_STRIP_ROW_H,
    overscan: 5,
    useFlushSync: false,
  })

  const activeMaxH = variant === 'full' ? ACTIVE_MAX_H_FULL : ACTIVE_MAX_H_POPUP
  const rootClass = variant === 'full' ? 'h-full min-h-0' : 'h-full min-h-0 max-h-full'

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-hidden', rootClass)}>
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="Downloaded"
          value={String(dashboardStats.completedCount)}
          sub={formatBytes(dashboardStats.completedBytes)}
          icon={HardDriveDownload}
        />
        <ActiveDownloadsStatTile count={dashboardStats.activeDownloadCount} />
        <StatTile
          label="Seeding"
          value={String(dashboardStats.seedingCount)}
          sub={formatBytes(dashboardStats.seedingBytes)}
          icon={HardDriveUpload}
        />
        <ActiveUploadsStatTile groupCount={dashboardStats.activeUploadCount} />
      </div>

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
              <div className="relative w-full" style={{ height: `${activeDownloadVirtualizer.getTotalSize()}px` }}>
                {activeDownloadVirtualizer.getVirtualItems().map((vi) => {
                  const row = activeDownloadRows[vi.index]
                  if (!row) return null
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
                      style={{ transform: `translateY(${vi.start}px)` } as CSSProperties}
                    >
                      <TransferCenterDownloadRow
                        row={row}
                        compact={false}
                        activeStrip
                        status={row.status}
                        progress={row.progress}
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
              <div className="relative w-full" style={{ height: `${activeUploadVirtualizer.getTotalSize()}px` }}>
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
                      style={{ transform: `translateY(${vi.start}px)` } as CSSProperties}
                    >
                      <TransferCenterActiveUploadStripRow
                        attachmentId={g.attachmentId}
                        requestIds={g.requestIds}
                        shared={shared}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 min-[450px]:grid-cols-2 overflow-hidden">
        <TransferCenterDownloadHistoryPane
          sectionBarClassName={TRANSFER_SECTION_BAR_BG}
          historyFilter={historyFilter}
          setHistoryFilter={setHistoryFilter}
          historyFiltersOpen={historyFiltersOpen}
          setHistoryFiltersOpen={setHistoryFiltersOpen}
          downloadHistoryForList={downloadHistoryForList}
          setMediaPreview={setMediaPreview}
          cancelTransferRequest={cancelTransferRequest}
          removeTransferHistoryEntry={removeTransferHistoryEntry}
        />
        <TransferCenterSeedingLibraryPane
          sectionBarClassName={TRANSFER_SECTION_BAR_BG}
          seedingFilter={seedingFilter}
          setSeedingFilter={setSeedingFilter}
          seedingFiltersOpen={seedingFiltersOpen}
          setSeedingFiltersOpen={setSeedingFiltersOpen}
          seedingLibraryFiltered={seedingLibraryFiltered}
          seedingSizeColumnCh={seedingSizeColumnCh}
          seedingDownloadersByGroupSha={seedingDownloadersByGroupSha}
          serversBySha={serversBySha}
          serverNameBySigningPubkey={serverNameBySigningPubkey}
          activeUploadSigningKeysBySha={activeUploadSigningKeysBySha}
          uploadsVisibleByShaCount={uploadsVisibleBySha.length}
          setMediaPreview={setMediaPreview}
          unshareFromServer={unshareFromServer}
          unshareAttachmentById={unshareAttachmentById}
        />
      </div>
    </div>
  )
}
