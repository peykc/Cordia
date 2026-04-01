import {
  memo,
  useCallback,
  useRef,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FunnelPlus, FunnelX } from 'lucide-react'
import { useIdentity } from '../contexts/IdentityContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import type { TransferHistoryEntry } from '../contexts/EphemeralMessagesContext'
import type { MediaPreviewState } from '../contexts/MediaPreviewContext'
import { cn } from '../lib/utils'
import type { TransferFileFilter } from '../lib/transferCenterFilters'
import { TransferCenterDownloadRow } from './TransferCenterDownloadRow'
import {
  TransferCenterSeedingRow,
  type SeedingDownloaderEntry,
  type SeedingGroup,
} from './TransferCenterSeedingRow'
import { FilterPills } from './TransferCenterFilterPills'

const HISTORY_ROW_H = 48
const SEED_ROW_H = 48

/** Memoized: skips re-render when transfer progress ticks but list props are unchanged (see selectors in panel). */
export const TransferCenterDownloadHistoryPane = memo(function TransferCenterDownloadHistoryPane({
  sectionBarClassName,
  historyFilter,
  setHistoryFilter,
  historyFiltersOpen,
  setHistoryFiltersOpen,
  downloadHistoryForList,
  setMediaPreview,
  cancelTransferRequest,
  removeTransferHistoryEntry,
}: {
  sectionBarClassName: string
  historyFilter: TransferFileFilter
  setHistoryFilter: (f: TransferFileFilter) => void
  historyFiltersOpen: boolean
  setHistoryFiltersOpen: Dispatch<SetStateAction<boolean>>
  downloadHistoryForList: TransferHistoryEntry[]
  setMediaPreview: (p: MediaPreviewState) => void
  cancelTransferRequest: (requestId: string) => void
  removeTransferHistoryEntry: (requestId: string) => void
}) {
  const { identity } = useIdentity()
  const remoteProfiles = useRemoteProfiles()
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const getScrollElement = useCallback(() => scrollParentRef.current, [])

  const historyVirtualizer = useVirtualizer({
    count: downloadHistoryForList.length,
    getScrollElement,
    estimateSize: () => HISTORY_ROW_H,
    overscan: 5,
    useFlushSync: false,
  })

  return (
    <div className="flex min-h-0 min-w-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
      <div className={cn('shrink-0 min-w-0 border-b border-border/40 px-2 py-2', sectionBarClassName)}>
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
      <div ref={scrollParentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {downloadHistoryForList.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">No entries</p>
        ) : (
          <div className="relative w-full" style={{ height: `${historyVirtualizer.getTotalSize()}px` }}>
            {historyVirtualizer.getVirtualItems().map((vi) => {
              const row = downloadHistoryForList[vi.index]
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
                  ref={historyVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vi.start}px)` } as CSSProperties}
                >
                  <TransferCenterDownloadRow
                    row={row}
                    compact={false}
                    omitProgressBar
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
  )
})

const EMPTY_SIGNING_SET: ReadonlySet<string> = new Set()

export const TransferCenterSeedingLibraryPane = memo(function TransferCenterSeedingLibraryPane({
  sectionBarClassName,
  seedingFilter,
  setSeedingFilter,
  seedingFiltersOpen,
  setSeedingFiltersOpen,
  seedingLibraryFiltered,
  seedingSizeColumnCh,
  seedingDownloadersByGroupSha,
  serversBySha,
  serverNameBySigningPubkey,
  activeUploadSigningKeysBySha,
  uploadsVisibleByShaCount,
  setMediaPreview,
  unshareFromServer,
  unshareAttachmentById,
}: {
  sectionBarClassName: string
  seedingFilter: TransferFileFilter
  setSeedingFilter: (f: TransferFileFilter) => void
  seedingFiltersOpen: boolean
  setSeedingFiltersOpen: Dispatch<SetStateAction<boolean>>
  seedingLibraryFiltered: SeedingGroup[]
  seedingSizeColumnCh: number
  seedingDownloadersByGroupSha: Map<string, SeedingDownloaderEntry[]>
  serversBySha: Map<string, string[]>
  serverNameBySigningPubkey: Map<string, string>
  activeUploadSigningKeysBySha: Map<string, Set<string>>
  uploadsVisibleByShaCount: number
  setMediaPreview: (p: MediaPreviewState) => void
  unshareFromServer: (serverKey: string, sha256: string) => void
  unshareAttachmentById: (attachmentId: string) => void
}) {
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const getScrollElement = useCallback(() => scrollParentRef.current, [])

  const seedVirtualizer = useVirtualizer({
    count: seedingLibraryFiltered.length,
    getScrollElement,
    estimateSize: () => SEED_ROW_H,
    overscan: 4,
    useFlushSync: false,
  })

  return (
    <div className="flex min-h-0 min-w-0 flex-col rounded-lg border border-border/50 bg-card/40 overflow-hidden">
      <div className={cn('shrink-0 min-w-0 border-b border-border/40 px-2 py-2', sectionBarClassName)}>
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
      <div ref={scrollParentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {seedingLibraryFiltered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            {uploadsVisibleByShaCount === 0 ? 'Nothing shared in any server' : 'No matches for filter'}
          </p>
        ) : (
          <div className="relative w-full" style={{ height: `${seedVirtualizer.getTotalSize()}px` }}>
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
                  style={{ transform: `translateY(${vi.start}px)` } as CSSProperties}
                >
                  <TransferCenterSeedingRow
                    group={group}
                    sizeColumnCh={seedingSizeColumnCh}
                    serversBySha={serversBySha}
                    serverNameBySigningPubkey={serverNameBySigningPubkey}
                    activeSigningPubkeys={activeSigningForSha}
                    downloaderEntries={seedingDownloadersByGroupSha.get(group.sha) ?? []}
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
  )
})
