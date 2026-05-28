import { useEffect } from 'react'
import { getCurrent } from '@tauri-apps/api/window'
import { useAccount } from '../../contexts/AccountContext'
import { selectHistoryColdPersistenceSig } from '../../domain/transfers/attachmentIndexes'
import type { TransferHistoryEntry } from '../../domain/transfers/types'
import { useEphemeralMessagesStore } from '../../stores/ephemeralMessagesStore'

const TRANSFER_HISTORY_KEY_PREFIX = 'cordia:attachment-transfer-history'
const PERSIST_DEBOUNCE_MS = 300

function transferHistoryKeyForAccount(accountId: string | null): string {
  return accountId ? `${TRANSFER_HISTORY_KEY_PREFIX}:${accountId}` : TRANSFER_HISTORY_KEY_PREFIX
}

function writeTransferHistory(accountId: string, history: TransferHistoryEntry[]): void {
  try {
    window.localStorage.setItem(transferHistoryKeyForAccount(accountId), JSON.stringify(history.slice(0, 300)))
  } catch {
    // ignore local storage write failures
  }
}

/** Persists cold transfer history via store subscribe — no React subscription to hot transfer slices. */
export function TransferHistoryPersistence() {
  const { currentAccountId } = useAccount()

  useEffect(() => {
    if (!currentAccountId) return

    let debounceTimer: ReturnType<typeof setTimeout> | undefined

    const unsubscribe = useEphemeralMessagesStore.subscribe((state, prev) => {
      const sig = selectHistoryColdPersistenceSig(state)
      const prevSig = selectHistoryColdPersistenceSig(prev)
      if (sig === prevSig) return
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        writeTransferHistory(currentAccountId, useEphemeralMessagesStore.getState().transferHistory)
      }, PERSIST_DEBOUNCE_MS)
    })

    return () => {
      clearTimeout(debounceTimer)
      unsubscribe()
    }
  }, [currentAccountId])

  useEffect(() => {
    if (!currentAccountId) return
    let unlisten: (() => void) | undefined
    getCurrent()
      .onCloseRequested(() => {
        const pruned = useEphemeralMessagesStore
          .getState()
          .transferHistory.filter((h) => h.is_inaccessible !== true)
          .slice(0, 300)
        writeTransferHistory(currentAccountId, pruned)
        useEphemeralMessagesStore.getState().setTransferHistory(pruned)
      })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})

    return () => {
      unlisten?.()
    }
  }, [currentAccountId])

  return null
}
