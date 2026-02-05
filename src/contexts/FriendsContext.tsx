import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { listFriends, addFriend as addFriendTauri, removeFriend as removeFriendTauri } from '../lib/tauri'
import { useAccount } from './AccountContext'
import { useSignaling } from './SignalingContext'
import { useIdentity } from './IdentityContext'
import { useRemoteProfiles } from './RemoteProfilesContext'
import * as friendApi from '../lib/friend-api'

export interface PendingIncomingItem {
  from_user_id: string
  from_display_name: string | null
  from_account_created_at?: string | null
}

export interface CodeRedemptionItem {
  redeemer_user_id: string
  redeemer_display_name: string
  redeemer_account_created_at?: string | null
}

interface FriendsContextType {
  friends: string[]
  pendingIncoming: PendingIncomingItem[]
  pendingOutgoing: string[]
  redemptions: CodeRedemptionItem[]
  myFriendCode: string | null
  refreshFriends: () => Promise<void>
  addFriend: (userId: string) => Promise<void>
  removeFriend: (userId: string) => Promise<void>
  isFriend: (userId: string) => boolean
  hasPendingOutgoing: (userId: string) => boolean
  sendFriendRequest: (toUserId: string, fromDisplayName?: string, fromAccountCreatedAt?: string | null) => Promise<void>
  acceptFriendRequest: (fromUserId: string, accepterDisplayName?: string, accepterAccountCreatedAt?: string | null) => Promise<void>
  declineFriendRequest: (fromUserId: string) => Promise<void>
  createFriendCode: () => Promise<string>
  revokeFriendCode: () => Promise<void>
  redeemFriendCode: (code: string, redeemerDisplayName: string, redeemerAccountCreatedAt?: string | null) => Promise<void>
  acceptCodeRedemption: (redeemerUserId: string, codeOwnerDisplayName?: string, codeOwnerAccountCreatedAt?: string | null) => Promise<void>
  declineCodeRedemption: (redeemerUserId: string) => Promise<void>
}

const FriendsContext = createContext<FriendsContextType | null>(null)

export function FriendsProvider({ children }: { children: ReactNode }) {
  const [friends, setFriends] = useState<string[]>([])
  const [pendingIncoming, setPendingIncoming] = useState<PendingIncomingItem[]>([])
  const [pendingOutgoing, setPendingOutgoing] = useState<string[]>([])
  const [redemptions, setRedemptions] = useState<CodeRedemptionItem[]>([])
  const [myFriendCode, setMyFriendCode] = useState<string | null>(null)
  const { currentAccountId, accountInfoMap } = useAccount()
  const { signalingUrl } = useSignaling()
  const { identity } = useIdentity()
  const { applyUpdate: applyRemoteProfile } = useRemoteProfiles()
  const identityUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    identityUserIdRef.current = identity?.user_id ?? null
  }, [identity?.user_id])

  const refreshFriends = useCallback(async () => {
    try {
      const list = await listFriends()
      setFriends(list)
    } catch (error) {
      console.error('Failed to load friends:', error)
      setFriends([])
    }
  }, [])

  useEffect(() => {
    if (!currentAccountId) {
      setFriends([])
      setPendingIncoming([])
      setPendingOutgoing([])
      setRedemptions([])
      setMyFriendCode(null)
      identityUserIdRef.current = null
      return
    }
    refreshFriends()
  }, [currentAccountId, refreshFriends])

  const addFriend = useCallback(async (userId: string) => {
    await addFriendTauri(userId)
    await refreshFriends()
    window.dispatchEvent(new Event('cordia:friends-updated'))
  }, [refreshFriends])

  const removeFriend = useCallback(
    async (userId: string) => {
      if (signalingUrl) {
        try {
          await friendApi.removeFriend(signalingUrl, userId)
        } catch (e) {
          console.warn('Beacon remove-friend notify failed:', e)
        }
      }
      await removeFriendTauri(userId)
      await refreshFriends()
      window.dispatchEvent(new Event('cordia:friends-updated'))
    },
    [refreshFriends, signalingUrl]
  )

  const isFriend = useCallback((userId: string) => friends.includes(userId), [friends])
  const hasPendingOutgoing = useCallback((userId: string) => pendingOutgoing.includes(userId), [pendingOutgoing])

  const sendFriendRequest = useCallback(
    async (toUserId: string, fromDisplayName?: string, fromAccountCreatedAt?: string | null) => {
      if (!signalingUrl) throw new Error('No beacon configured')
      const accountCreatedAt = fromAccountCreatedAt ?? (currentAccountId ? accountInfoMap[currentAccountId]?.created_at ?? null : null)
      const result = await friendApi.sendFriendRequest(signalingUrl, toUserId, fromDisplayName, accountCreatedAt)
      if (result.accepted || result.mutual) {
        await addFriend(toUserId)
        setPendingOutgoing((prev) => prev.filter((id) => id !== toUserId))
      } else if (result.sent || result.already_sent) {
        setPendingOutgoing((prev) => (prev.includes(toUserId) ? prev : [...prev, toUserId]))
      }
    },
    [signalingUrl, addFriend, currentAccountId, accountInfoMap]
  )

  const acceptFriendRequest = useCallback(
    async (fromUserId: string, accepterDisplayName?: string, accepterAccountCreatedAt?: string | null) => {
      if (!signalingUrl) throw new Error('No beacon configured')
      const accountCreatedAt = accepterAccountCreatedAt ?? (currentAccountId ? accountInfoMap[currentAccountId]?.created_at ?? null : null)
      await friendApi.acceptFriendRequest(signalingUrl, fromUserId, accepterDisplayName, accountCreatedAt)
      setPendingIncoming((prev) => prev.filter((r) => r.from_user_id !== fromUserId))
      await addFriend(fromUserId)
    },
    [signalingUrl, addFriend, currentAccountId, accountInfoMap]
  )

  const declineFriendRequest = useCallback(
    async (fromUserId: string) => {
      if (!signalingUrl) throw new Error('No beacon configured')
      await friendApi.declineFriendRequest(signalingUrl, fromUserId)
      setPendingIncoming((prev) => prev.filter((r) => r.from_user_id !== fromUserId))
    },
    [signalingUrl]
  )

  const createFriendCode = useCallback(async () => {
    if (!signalingUrl) throw new Error('No beacon configured')
    const result = await friendApi.createFriendCode(signalingUrl)
    setMyFriendCode(result.code)
    return result.code
  }, [signalingUrl])

  const revokeFriendCode = useCallback(async () => {
    if (!signalingUrl) throw new Error('No beacon configured')
    await friendApi.revokeFriendCode(signalingUrl)
    setMyFriendCode(null)
  }, [signalingUrl])

  const redeemFriendCode = useCallback(
    async (code: string, redeemerDisplayName: string, redeemerAccountCreatedAt?: string | null) => {
      if (!signalingUrl) throw new Error('No beacon configured')
      const identityUserId = identity?.user_id ?? identityUserIdRef.current
      if (!identityUserId) throw new Error('Not logged in')
      const accountCreatedAt = redeemerAccountCreatedAt ?? (currentAccountId ? accountInfoMap[currentAccountId]?.created_at ?? null : null)
      const result = await friendApi.redeemFriendCode(signalingUrl, code, identityUserId, redeemerDisplayName, accountCreatedAt)
      if (result.code_owner_id && !friends.includes(result.code_owner_id)) {
        setPendingOutgoing((prev) =>
          prev.includes(result.code_owner_id!) ? prev : [...prev, result.code_owner_id!]
        )
      }
    },
    [signalingUrl, identity?.user_id, currentAccountId, accountInfoMap, friends]
  )

  const acceptCodeRedemption = useCallback(
    async (redeemerUserId: string, codeOwnerDisplayName?: string, codeOwnerAccountCreatedAt?: string | null) => {
      if (!signalingUrl) throw new Error('No beacon configured')
      const accountCreatedAt = codeOwnerAccountCreatedAt ?? (currentAccountId ? accountInfoMap[currentAccountId]?.created_at ?? null : null)
      await friendApi.acceptCodeRedemption(signalingUrl, redeemerUserId, codeOwnerDisplayName, accountCreatedAt)
      setRedemptions((prev) => prev.filter((r) => r.redeemer_user_id !== redeemerUserId))
      await addFriend(redeemerUserId)
    },
    [signalingUrl, addFriend, currentAccountId, accountInfoMap]
  )

  const declineCodeRedemption = useCallback(
    async (redeemerUserId: string) => {
      if (!signalingUrl) throw new Error('No beacon configured')
      await friendApi.declineCodeRedemption(signalingUrl, redeemerUserId)
      setRedemptions((prev) => prev.filter((r) => r.redeemer_user_id !== redeemerUserId))
    },
    [signalingUrl]
  )

  // Subscribe to friend WebSocket events (dispatched by ServerSyncBootstrap)
  useEffect(() => {
    const onPendingSnapshot = (e: Event) => {
      const ev = e as CustomEvent<{
        pending_incoming: Array<{ from_user_id: string; from_display_name?: string | null; from_account_created_at?: string | null }>
        pending_outgoing: string[]
        pending_code_redemptions: Array<{ redeemer_user_id: string; redeemer_display_name: string; redeemer_account_created_at?: string | null }>
      }>
      const d = ev.detail
      if (d) {
        setPendingIncoming(
          (d.pending_incoming ?? []).map((x) => ({
            from_user_id: x.from_user_id,
            from_display_name: x.from_display_name ?? null,
            from_account_created_at: x.from_account_created_at ?? null,
          }))
        )
        setPendingOutgoing(d.pending_outgoing ?? [])
        setRedemptions(
          (d.pending_code_redemptions ?? []).map((x) => ({
            redeemer_user_id: x.redeemer_user_id,
            redeemer_display_name: x.redeemer_display_name ?? '',
            redeemer_account_created_at: x.redeemer_account_created_at ?? null,
          }))
        )
        for (const x of d.pending_incoming ?? []) {
          if (x.from_user_id && (x.from_display_name != null || x.from_account_created_at != null)) {
            applyRemoteProfile({
              user_id: x.from_user_id,
              display_name: x.from_display_name ?? '',
              secondary_name: null,
              show_secondary: false,
              rev: 0,
              account_created_at: x.from_account_created_at ?? undefined,
            })
          }
        }
      }
    }
    const onRequestIncoming = (e: Event) => {
      const ev = e as CustomEvent<{ from_user_id: string; from_display_name?: string | null; from_account_created_at?: string | null }>
      const d = ev.detail
      if (d?.from_user_id) {
        setPendingIncoming((prev) =>
          prev.some((r) => r.from_user_id === d.from_user_id)
            ? prev
            : [...prev, { from_user_id: d.from_user_id, from_display_name: d.from_display_name ?? null, from_account_created_at: d.from_account_created_at ?? null }]
        )
        if (d.from_display_name != null || d.from_account_created_at != null) {
          applyRemoteProfile({
            user_id: d.from_user_id,
            display_name: d.from_display_name ?? '',
            secondary_name: null,
            show_secondary: false,
            rev: 0,
            account_created_at: d.from_account_created_at ?? undefined,
          })
        }
      }
    }
    const onRequestAccepted = (e: Event) => {
      const ev = e as CustomEvent<{ from_user_id: string; to_user_id: string; from_display_name?: string | null; from_account_created_at?: string | null }>
      const d = ev.detail
      if (d && identityUserIdRef.current === d.to_user_id) {
        setPendingOutgoing((prev) => prev.filter((id) => id !== d.from_user_id))
        if (d.from_display_name != null || d.from_account_created_at != null) {
          applyRemoteProfile({
            user_id: d.from_user_id,
            display_name: d.from_display_name ?? '',
            secondary_name: null,
            show_secondary: false,
            rev: 1,
            account_created_at: d.from_account_created_at ?? undefined,
          })
        }
        addFriend(d.from_user_id).catch(console.error)
      }
    }
    const onRequestDeclined = (e: Event) => {
      const ev = e as CustomEvent<{ from_user_id: string; to_user_id: string }>
      const d = ev.detail
      if (d && identityUserIdRef.current === d.to_user_id) {
        setPendingOutgoing((prev) => prev.filter((id) => id !== d.from_user_id))
      }
    }
    const onRedemptionIncoming = (e: Event) => {
      const ev = e as CustomEvent<{ redeemer_user_id: string; redeemer_display_name: string; redeemer_account_created_at?: string | null }>
      const d = ev.detail
      if (d?.redeemer_user_id) {
        setRedemptions((prev) =>
          prev.some((r) => r.redeemer_user_id === d.redeemer_user_id)
            ? prev
            : [...prev, { redeemer_user_id: d.redeemer_user_id, redeemer_display_name: d.redeemer_display_name ?? '', redeemer_account_created_at: d.redeemer_account_created_at ?? null }]
        )
      }
    }
    const onRedemptionAccepted = (e: Event) => {
      const ev = e as CustomEvent<{
        code_owner_id: string
        redeemer_user_id: string
        code_owner_display_name?: string | null
        code_owner_account_created_at?: string | null
      }>
      const d = ev.detail
      if (d && identityUserIdRef.current === d.redeemer_user_id) {
        setPendingOutgoing((prev) => prev.filter((id) => id !== d.code_owner_id))
        if (d.code_owner_display_name != null || d.code_owner_account_created_at != null) {
          applyRemoteProfile({
            user_id: d.code_owner_id,
            display_name: d.code_owner_display_name ?? '',
            secondary_name: null,
            show_secondary: false,
            rev: 1,
            account_created_at: d.code_owner_account_created_at ?? undefined,
          })
        }
        addFriend(d.code_owner_id).catch(console.error)
      }
    }
    const onRedemptionDeclined = (e: Event) => {
      const ev = e as CustomEvent<{ code_owner_id: string; redeemer_user_id: string }>
      const d = ev.detail
      if (d && identityUserIdRef.current === d.redeemer_user_id) {
        setPendingOutgoing((prev) => prev.filter((id) => id !== d.code_owner_id))
      }
    }
    const onFriendRemoved = (e: Event) => {
      const ev = e as CustomEvent<{ from_user_id: string }>
      const d = ev.detail
      if (d?.from_user_id) {
        removeFriendTauri(d.from_user_id).then(() => refreshFriends()).catch(console.error)
      }
    }

    window.addEventListener('cordia:friend-pending-snapshot', onPendingSnapshot)
    window.addEventListener('cordia:friend-request-incoming', onRequestIncoming)
    window.addEventListener('cordia:friend-request-accepted', onRequestAccepted)
    window.addEventListener('cordia:friend-request-declined', onRequestDeclined)
    window.addEventListener('cordia:friend-code-redemption-incoming', onRedemptionIncoming)
    window.addEventListener('cordia:friend-code-redemption-accepted', onRedemptionAccepted)
    window.addEventListener('cordia:friend-code-redemption-declined', onRedemptionDeclined)
    window.addEventListener('cordia:friend-removed', onFriendRemoved)
    return () => {
      window.removeEventListener('cordia:friend-pending-snapshot', onPendingSnapshot)
      window.removeEventListener('cordia:friend-request-incoming', onRequestIncoming)
      window.removeEventListener('cordia:friend-request-accepted', onRequestAccepted)
      window.removeEventListener('cordia:friend-request-declined', onRequestDeclined)
      window.removeEventListener('cordia:friend-code-redemption-incoming', onRedemptionIncoming)
      window.removeEventListener('cordia:friend-code-redemption-accepted', onRedemptionAccepted)
      window.removeEventListener('cordia:friend-code-redemption-declined', onRedemptionDeclined)
      window.removeEventListener('cordia:friend-removed', onFriendRemoved)
    }
  }, [addFriend, refreshFriends, applyRemoteProfile])

  const value: FriendsContextType = {
    friends,
    pendingIncoming,
    pendingOutgoing,
    redemptions,
    myFriendCode,
    refreshFriends,
    addFriend,
    removeFriend,
    isFriend,
    hasPendingOutgoing,
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    createFriendCode,
    revokeFriendCode,
    redeemFriendCode,
    acceptCodeRedemption,
    declineCodeRedemption,
  }

  return <FriendsContext.Provider value={value}>{children}</FriendsContext.Provider>
}

export function useFriends() {
  const ctx = useContext(FriendsContext)
  if (!ctx) throw new Error('useFriends must be used within a FriendsProvider')
  return ctx
}
