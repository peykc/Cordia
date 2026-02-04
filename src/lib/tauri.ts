import { invoke } from '@tauri-apps/api/tauri'

export interface UserIdentity {
  user_id: string
  display_name: string
  public_key: string
  private_key?: string
}

export async function hasIdentity(): Promise<boolean> {
  return await invoke('has_identity')
}

export async function checkAccountHasIdentity(accountId: string): Promise<boolean> {
  return await invoke('check_account_has_identity', { accountId })
}

export async function createIdentity(displayName: string): Promise<UserIdentity> {
  return await invoke('create_identity', { displayName })
}

export async function loadIdentity(): Promise<UserIdentity> {
  return await invoke('load_identity')
}

export async function exportIdentity(): Promise<Uint8Array> {
  const data = await invoke<number[]>('export_identity')
  return new Uint8Array(data)
}

export async function importIdentity(data: Uint8Array): Promise<{ identity: UserIdentity, profile_json: any }> {
  return await invoke('import_identity', { data: Array.from(data) })
}

export interface AudioSettings {
  input_device_id: string | null
  output_device_id: string | null
  input_volume: number
  input_sensitivity: number
  output_volume: number
  input_mode: 'voice_activity' | 'push_to_talk'
  push_to_talk_key: string | null
}

export async function loadAudioSettings(): Promise<AudioSettings> {
  return await invoke('load_audio_settings')
}

export async function saveAudioSettings(settings: AudioSettings): Promise<void> {
  return await invoke('save_audio_settings', { settings })
}

export interface Chat {
  id: string
  name: string
  description: string | null
}

export interface ServerMember {
  user_id: string
  display_name: string
  joined_at: string
  x25519_pubkey: string | null  // Base64-encoded X25519 public key for key exchange
}

export type ConnectionMode = 'Signaling' | 'DHT' | 'Manual'

export interface Server {
  id: string
  name: string
  created_at: string
  chats: Chat[]
  members: ServerMember[]

  // Cryptographic fields (Ed25519 signing)
  signing_pubkey: string
  invite_uri: string
  connection_mode: ConnectionMode
  signaling_url: string | null

  // Legacy fields - kept for backward compatibility
  public_key: string
  invite_code: string
  active_invite_uri?: string | null
  active_invite_expires_at?: string | null

  // Cryptographic key availability (for UI)
  has_symmetric_key: boolean
  has_signing_key: boolean
}

export interface EncryptedServerHint {
  signing_pubkey: string
  encrypted_state: string
  signature: string
  last_updated: string
}

export async function createServer(name: string, userId: string, displayName: string): Promise<Server> {
  return await invoke('create_server', { name, userId, displayName })
}

export async function listServers(): Promise<Server[]> {
  return await invoke('list_servers')
}

export async function loadServer(serverId: string): Promise<Server> {
  return await invoke('load_server', { serverId })
}

export async function deleteServer(serverId: string): Promise<void> {
  return await invoke('delete_server', { serverId })
}

export async function findServerByInvite(inviteCode: string): Promise<Server | null> {
  return await invoke('find_server_by_invite', { inviteCode })
}

export async function joinServer(serverId: string, userId: string, displayName: string): Promise<Server> {
  return await invoke('join_server', { serverId, userId, displayName })
}

export async function addRoom(serverId: string, name: string, description: string | null): Promise<Server> {
  return await invoke('add_room', { serverId, name, description })
}

export async function removeChat(serverId: string, roomId: string): Promise<Server> {
  return await invoke('remove_chat', { serverId, roomId })
}


export async function importServerHint(server: Server): Promise<void> {
  return await invoke('import_server_hint', { server })
}

export async function registerServerHint(signalingServer: string, hint: EncryptedServerHint): Promise<void> {
  return await invoke('register_server_hint', { signalingServer, hint })
}

export async function getServerHint(signalingServer: string, signingPubkey: string): Promise<EncryptedServerHint | null> {
  return await invoke('get_server_hint', { signalingServer, signingPubkey })
}

export async function publishServerHintOpaque(signalingServer: string, serverId: string): Promise<void> {
  return await invoke('publish_server_hint_opaque', { signalingServer, serverId })
}

export async function publishServerHintMemberLeft(signalingServer: string, serverId: string, userId: string): Promise<void> {
  return await invoke('publish_server_hint_member_left', { signalingServer, serverId, userId })
}

export async function fetchAndImportServerHintOpaque(signalingServer: string, signingPubkey: string): Promise<boolean> {
  return await invoke('fetch_and_import_server_hint_opaque', { signalingServer, signingPubkey })
}

export async function resolveInviteCode(signalingServer: string, inviteCode: string): Promise<string | null> {
  return await invoke('resolve_invite_code', { signalingServer, inviteCode })
}

export async function createTemporaryInvite(signalingServer: string, serverId: string, maxUses: number): Promise<string> {
  return await invoke('create_temporary_invite', { signalingServer, serverId, maxUses })
}

export async function redeemTemporaryInvite(
  signalingServer: string,
  code: string,
  userId: string,
  displayName: string
): Promise<Server> {
  return await invoke('redeem_temporary_invite', { signalingServer, code, userId, displayName })
}

export async function revokeActiveInvite(signalingServer: string, serverId: string): Promise<void> {
  return await invoke('revoke_active_invite', { signalingServer, serverId })
}

export async function checkSignalingServer(url?: string): Promise<boolean> {
  return await invoke('check_signaling_server', { url })
}

export async function getDefaultSignalingServer(): Promise<string> {
  return await invoke('get_default_signaling_server')
}

export async function getSignalingServerUrl(): Promise<string> {
  return await invoke('get_signaling_server_url')
}

export async function setSignalingServerUrl(url: string): Promise<void> {
  return await invoke('set_signaling_server_url', { url })
}

// === Account Management ===

export interface SessionState {
  current_account_id: string | null
  last_login: string | null
}

export interface AccountInfo {
  account_id: string
  display_name: string
  created_at: string
}

export async function listAccounts(): Promise<string[]> {
  return await invoke('list_accounts')
}

export async function getAccountInfo(accountId: string): Promise<AccountInfo | null> {
  return await invoke('get_account_info', { accountId })
}

export async function getCurrentSession(): Promise<SessionState> {
  return await invoke('get_current_session')
}

export async function switchAccount(accountId: string): Promise<void> {
  return await invoke('switch_account', { accountId })
}

export async function logoutAccount(): Promise<void> {
  return await invoke('logout_account')
}

export async function getCurrentAccountId(): Promise<string | null> {
  return await invoke('get_current_account_id')
}

export async function exportIdentityForAccount(accountId: string): Promise<Uint8Array> {
  const data = await invoke<number[]>('export_identity_for_account', { accountId })
  return new Uint8Array(data)
}

export async function exportFullIdentity(profileJson?: any): Promise<Uint8Array> {
  const data = await invoke<number[]>('export_full_identity', { profileJson })
  return new Uint8Array(data)
}

export async function exportFullIdentityDebug(profileJson?: any): Promise<string> {
  return await invoke('export_full_identity_debug', { profileJson })
}

export async function exportFullIdentityForAccount(accountId: string, profileJson?: any): Promise<Uint8Array> {
  const data = await invoke<number[]>('export_full_identity_for_account', { accountId, profileJson })
  return new Uint8Array(data)
}

export async function deleteAccount(accountId: string): Promise<void> {
  return await invoke('delete_account', { accountId })
}

export async function listFriends(): Promise<string[]> {
  return await invoke('list_friends')
}

export async function addFriend(userId: string): Promise<void> {
  return await invoke('add_friend', { userId })
}

export async function removeFriend(userId: string): Promise<void> {
  return await invoke('remove_friend', { userId })
}

/**
 * Headers for friend API auth (X-User-Id + X-Timestamp + HMAC X-Signature).
 * Requires FRIEND_API_SECRET env to match server's SIGNALING_FRIEND_API_SECRET.
 */
export async function getFriendAuthHeaders(): Promise<Record<string, string>> {
  return await invoke<Record<string, string>>('get_friend_auth_headers')
}

export async function registerKeyFileAssociation(): Promise<void> {
  return await invoke('register_key_file_association_command')
}

// === Invite URI Helpers ===

/**
 * Parse an invite URI into its components
 * Format: cordia://{signing_pubkey}@{server}
 */
export function parseInviteUri(uri: string): { signingPubkey: string; server: string } | null {
  // Be tolerant of users pasting uppercased scheme (e.g. CORDIA://...), and trim whitespace.
  const match = uri.trim().match(/^cordia:\/\/([^@]+)@(.+)$/i)
  if (!match) return null
  return {
    signingPubkey: match[1],
    server: match[2],
  }
}

/**
 * Get the HTTP base URL from a signaling server URL
 */
export function getHttpUrl(signalingServer: string): string {
  let url = signalingServer
  if (url.startsWith('wss://')) {
    url = 'https://' + url.slice(6)
  } else if (url.startsWith('ws://')) {
    url = 'http://' + url.slice(5)
  } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url
  }
  return url.replace(/\/$/, '')
}
