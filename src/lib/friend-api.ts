/**
 * Friend API: calls to signaling server /api/friends/* with Ed25519-signed auth.
 * Each request is signed with identity key (method + path + timestamp + body hash).
 */

import { getFriendAuthHeaders } from './tauri'
import { getHttpUrl } from './tauri'

async function friendFetch(
  signalingUrl: string,
  path: string,
  options: { method: string; body?: object }
): Promise<unknown> {
  const base = getHttpUrl(signalingUrl)
  const fullPath = `/api/friends${path}`
  const url = `${base.replace(/\/$/, '')}${fullPath}`
  const bodyStr = options.body != null ? JSON.stringify(options.body) : undefined
  const headers = await getFriendAuthHeaders(options.method, fullPath, bodyStr ?? null)
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  }
  const res = await fetch(url, {
    method: options.method,
    headers: reqHeaders,
    body: bodyStr,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(res.status === 401 ? 'Friend API auth failed' : text || `HTTP ${res.status}`)
  }
  const contentType = res.headers.get('content-type')
  if (contentType?.includes('application/json')) {
    return await res.json()
  }
  return undefined
}

export interface SendFriendRequestResult {
  accepted?: boolean
  mutual?: boolean
  sent?: boolean
  already_sent?: boolean
}

export async function sendFriendRequest(
  signalingUrl: string,
  toUserId: string,
  fromDisplayName?: string,
  fromAccountCreatedAt?: string | null
): Promise<SendFriendRequestResult> {
  return friendFetch(signalingUrl, '/requests', {
    method: 'POST',
    body: {
      to_user_id: toUserId,
      from_display_name: fromDisplayName ?? null,
      from_account_created_at: fromAccountCreatedAt ?? null,
    },
  }) as Promise<SendFriendRequestResult>
}

export async function acceptFriendRequest(
  signalingUrl: string,
  fromUserId: string,
  accepterDisplayName?: string,
  accepterAccountCreatedAt?: string | null
): Promise<{ accepted: boolean }> {
  return friendFetch(signalingUrl, '/requests/accept', {
    method: 'POST',
    body: {
      from_user_id: fromUserId,
      from_display_name: accepterDisplayName ?? null,
      from_account_created_at: accepterAccountCreatedAt ?? null,
    },
  }) as Promise<{ accepted: boolean }>
}

export async function declineFriendRequest(
  signalingUrl: string,
  fromUserId: string
): Promise<{ declined: boolean }> {
  return friendFetch(signalingUrl, '/requests/decline', {
    method: 'POST',
    body: { from_user_id: fromUserId },
  }) as Promise<{ declined: boolean }>
}

export interface CreateFriendCodeResult {
  code: string
  created_at: string
}

export async function createFriendCode(
  signalingUrl: string
): Promise<CreateFriendCodeResult> {
  return friendFetch(signalingUrl, '/codes', { method: 'POST' }) as Promise<CreateFriendCodeResult>
}

export async function revokeFriendCode(
  signalingUrl: string
): Promise<{ revoked: boolean }> {
  return friendFetch(signalingUrl, '/codes/revoke', { method: 'POST' }) as Promise<{ revoked: boolean }>
}

export async function redeemFriendCode(
  signalingUrl: string,
  code: string,
  redeemerUserId: string,
  redeemerDisplayName: string,
  redeemerAccountCreatedAt?: string | null
): Promise<{ pending: boolean }> {
  return friendFetch(signalingUrl, '/codes/redeem', {
    method: 'POST',
    body: {
      code: code.trim().toUpperCase(),
      redeemer_user_id: redeemerUserId,
      redeemer_display_name: redeemerDisplayName,
      redeemer_account_created_at: redeemerAccountCreatedAt ?? null,
    },
  }) as Promise<{ pending: boolean }>
}

export async function acceptCodeRedemption(
  signalingUrl: string,
  redeemerUserId: string,
  codeOwnerDisplayName?: string,
  codeOwnerAccountCreatedAt?: string | null
): Promise<{ accepted: boolean }> {
  return friendFetch(signalingUrl, '/codes/redemptions/accept', {
    method: 'POST',
    body: {
      redeemer_user_id: redeemerUserId,
      code_owner_display_name: codeOwnerDisplayName ?? null,
      code_owner_account_created_at: codeOwnerAccountCreatedAt ?? null,
    },
  }) as Promise<{ accepted: boolean }>
}

export async function declineCodeRedemption(
  signalingUrl: string,
  redeemerUserId: string
): Promise<{ declined: boolean }> {
  return friendFetch(signalingUrl, '/codes/redemptions/decline', {
    method: 'POST',
    body: { redeemer_user_id: redeemerUserId },
  }) as Promise<{ declined: boolean }>
}

export async function removeFriend(
  signalingUrl: string,
  friendUserId: string
): Promise<{ removed: boolean }> {
  return friendFetch(signalingUrl, '/remove', {
    method: 'POST',
    body: { friend_user_id: friendUserId },
  }) as Promise<{ removed: boolean }>
}
