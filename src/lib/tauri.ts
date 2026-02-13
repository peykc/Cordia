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

export async function encryptEphemeralChatMessage(serverId: string, plaintext: string): Promise<string> {
  return await invoke('encrypt_ephemeral_chat_message', { serverId, plaintext })
}

export async function encryptEphemeralChatMessageBySigningPubkey(
  signingPubkey: string,
  plaintext: string
): Promise<string> {
  return await invoke('encrypt_ephemeral_chat_message_by_signing_pubkey', { signingPubkey, plaintext })
}

export async function decryptEphemeralChatMessage(serverId: string, encryptedPayloadB64: string): Promise<string> {
  return await invoke('decrypt_ephemeral_chat_message', { serverId, encryptedPayloadB64 })
}

export async function decryptEphemeralChatMessageBySigningPubkey(
  signingPubkey: string,
  encryptedPayloadB64: string
): Promise<string> {
  return await invoke('decrypt_ephemeral_chat_message_by_signing_pubkey', { signingPubkey, encryptedPayloadB64 })
}

export interface AttachmentRegistrationResult {
  attachment_id: string
  sha256: string
  file_name: string
  extension: string
  size_bytes: number
  storage_mode: 'current_path' | 'program_copy' | string
}

export interface SharedAttachmentItem {
  attachment_id: string
  sha256: string
  file_name: string
  extension: string
  size_bytes: number
  storage_mode: 'current_path' | 'program_copy' | string
  source_path?: string | null
  file_path?: string | null
  thumbnail_path?: string | null
  created_at: string
  can_share_now: boolean
}

export async function registerAttachmentFromPath(
  path: string,
  storageMode: 'current_path' | 'program_copy'
): Promise<AttachmentRegistrationResult> {
  return await invoke('register_attachment_from_path', { path, storageMode })
}

export async function getAttachmentRecord(attachmentId: string): Promise<AttachmentRegistrationResult | null> {
  return await invoke('get_attachment_record', { attachmentId })
}

export async function listSharedAttachments(): Promise<SharedAttachmentItem[]> {
  return await invoke('list_shared_attachments')
}

export async function unshareAttachment(attachmentId: string): Promise<boolean> {
  return await invoke('unshare_attachment', { attachmentId })
}

export async function readAttachmentBytes(attachmentId: string): Promise<Uint8Array> {
  const data = await invoke<number[]>('read_attachment_bytes', { attachmentId })
  return new Uint8Array(data)
}

export async function saveDownloadedAttachment(
  fileName: string,
  bytes: Uint8Array,
  sha256?: string | null,
  targetDir?: string | null
): Promise<string> {
  return await invoke('save_downloaded_attachment', {
    fileName,
    bytes: Array.from(bytes),
    sha256: sha256 ?? null,
    targetDir: targetDir ?? null,
  })
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

export async function importServerHint(server: Server): Promise<void> {
  return await invoke('import_server_hint', { server })
}

export async function registerServerHint(beaconUrl: string, hint: EncryptedServerHint): Promise<void> {
  return await invoke('register_server_hint', { beaconUrl, hint })
}

export async function getServerHint(beaconUrl: string, signingPubkey: string): Promise<EncryptedServerHint | null> {
  return await invoke('get_server_hint', { beaconUrl, signingPubkey })
}

export async function publishServerHintOpaque(beaconUrl: string, serverId: string): Promise<void> {
  return await invoke('publish_server_hint_opaque', { beaconUrl, serverId })
}

export async function publishServerHintMemberLeft(beaconUrl: string, serverId: string, userId: string): Promise<void> {
  return await invoke('publish_server_hint_member_left', { beaconUrl, serverId, userId })
}

export async function fetchAndImportServerHintOpaque(beaconUrl: string, signingPubkey: string): Promise<boolean> {
  return await invoke('fetch_and_import_server_hint_opaque', { beaconUrl, signingPubkey })
}

export async function resolveInviteCode(beaconUrl: string, inviteCode: string): Promise<string | null> {
  return await invoke('resolve_invite_code', { beaconUrl, inviteCode })
}

export async function createTemporaryInvite(beaconUrl: string, serverId: string, maxUses: number): Promise<string> {
  return await invoke('create_temporary_invite', { beaconUrl, serverId, maxUses })
}

export async function redeemTemporaryInvite(
  beaconUrl: string,
  code: string,
  userId: string,
  displayName: string
): Promise<Server> {
  return await invoke('redeem_temporary_invite', { beaconUrl, code, userId, displayName })
}

export async function revokeActiveInvite(beaconUrl: string, serverId: string): Promise<void> {
  return await invoke('revoke_active_invite', { beaconUrl, serverId })
}

export async function checkBeacon(url?: string): Promise<boolean> {
  return await invoke('check_beacon', { url })
}

export async function getDefaultBeacon(): Promise<string> {
  return await invoke('get_default_beacon')
}

export async function getBeaconUrl(): Promise<string> {
  return await invoke('get_beacon_url')
}

export async function setBeaconUrl(url: string): Promise<void> {
  return await invoke('set_beacon_url', { url })
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

/** Persisted profile per account (incl. optional avatar). Avatar is stored locally only, not in .key export. */
export interface KnownProfile {
  display_name: string
  secondary_name?: string | null
  show_secondary?: boolean
  rev?: number
  account_created_at?: string | null
  avatar_data_url?: string | null
  avatar_rev?: number
}

export async function loadKnownProfiles(): Promise<Record<string, KnownProfile>> {
  const map = await invoke<Record<string, KnownProfile>>('load_known_profiles')
  return map ?? {}
}

export async function saveKnownProfiles(profiles: Record<string, KnownProfile>): Promise<void> {
  return await invoke('save_known_profiles', { profiles })
}

/**
 * Headers for friend API auth: request signed with identity Ed25519 key.
 * Pass method, full path (e.g. /api/friends/requests), and optional body string.
 * No shared secret; server verifies signature with public key.
 */
export async function getFriendAuthHeaders(
  method: string,
  path: string,
  body?: string | null
): Promise<Record<string, string>> {
  return await invoke<Record<string, string>>('get_friend_auth_headers', {
    method,
    path,
    body: body ?? null,
  })
}

/** Prefer when in Tauri app to avoid webview "Allow this site to read from your clipboard?" prompt. */
export async function readClipboardText(): Promise<string> {
  return await invoke<string>('read_clipboard_text')
}

export async function openPathInFileExplorer(path: string): Promise<void> {
  return await invoke('open_path_in_file_explorer', { path })
}

export async function pathExists(path: string): Promise<boolean> {
  return await invoke('path_exists', { path })
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
 * Get the HTTP base URL from a beacon URL
 */
export function getHttpUrl(beaconUrl: string): string {
  let url = beaconUrl
  if (url.startsWith('wss://')) {
    url = 'https://' + url.slice(6)
  } else if (url.startsWith('ws://')) {
    url = 'http://' + url.slice(5)
  } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url
  }
  return url.replace(/\/$/, '')
}
