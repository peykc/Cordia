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

export async function importIdentity(data: Uint8Array): Promise<UserIdentity> {
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

export interface Room {
  id: string
  name: string
  description: string | null
}

export interface HouseMember {
  user_id: string
  display_name: string
  joined_at: string
  x25519_pubkey: string | null  // Base64-encoded X25519 public key for key exchange
}

export type ConnectionMode = 'Signaling' | 'DHT' | 'Manual'

export interface House {
  id: string
  name: string
  created_at: string
  rooms: Room[]
  members: HouseMember[]

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

export interface EncryptedHouseHint {
  signing_pubkey: string
  encrypted_state: string
  signature: string
  last_updated: string
}

export async function createHouse(name: string, userId: string, displayName: string): Promise<House> {
  return await invoke('create_house', { name, userId, displayName })
}

export async function listHouses(): Promise<House[]> {
  return await invoke('list_houses')
}

export async function loadHouse(houseId: string): Promise<House> {
  return await invoke('load_house', { houseId })
}

export async function deleteHouse(houseId: string): Promise<void> {
  return await invoke('delete_house', { houseId })
}

export async function findHouseByInvite(inviteCode: string): Promise<House | null> {
  return await invoke('find_house_by_invite', { inviteCode })
}

export async function joinHouse(houseId: string, userId: string, displayName: string): Promise<House> {
  return await invoke('join_house', { houseId, userId, displayName })
}

export async function addRoom(houseId: string, name: string, description: string | null): Promise<House> {
  return await invoke('add_room', { houseId, name, description })
}


export async function importHouseHint(house: House): Promise<void> {
  return await invoke('import_house_hint', { house })
}

export async function registerHouseHint(signalingServer: string, hint: EncryptedHouseHint): Promise<void> {
  return await invoke('register_house_hint', { signalingServer, hint })
}

export async function getHouseHint(signalingServer: string, signingPubkey: string): Promise<EncryptedHouseHint | null> {
  return await invoke('get_house_hint', { signalingServer, signingPubkey })
}

export async function publishHouseHintOpaque(signalingServer: string, houseId: string): Promise<void> {
  return await invoke('publish_house_hint_opaque', { signalingServer, houseId })
}

export async function publishHouseHintMemberLeft(signalingServer: string, houseId: string, userId: string): Promise<void> {
  return await invoke('publish_house_hint_member_left', { signalingServer, houseId, userId })
}

export async function fetchAndImportHouseHintOpaque(signalingServer: string, signingPubkey: string): Promise<boolean> {
  return await invoke('fetch_and_import_house_hint_opaque', { signalingServer, signingPubkey })
}

export async function resolveInviteCode(signalingServer: string, inviteCode: string): Promise<string | null> {
  return await invoke('resolve_invite_code', { signalingServer, inviteCode })
}

export async function createTemporaryInvite(signalingServer: string, houseId: string, ttlSeconds: number): Promise<string> {
  return await invoke('create_temporary_invite', { signalingServer, houseId, ttlSeconds })
}

export async function redeemTemporaryInvite(
  signalingServer: string,
  code: string,
  userId: string,
  displayName: string
): Promise<House> {
  return await invoke('redeem_temporary_invite', { signalingServer, code, userId, displayName })
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

// === Invite URI Helpers ===

/**
 * Parse an invite URI into its components
 * Format: rmmt://{signing_pubkey}@{server}
 */
export function parseInviteUri(uri: string): { signingPubkey: string; server: string } | null {
  // Be tolerant of users pasting uppercased scheme (e.g. RMMT://...), and trim whitespace.
  const match = uri.trim().match(/^rmmt:\/\/([^@]+)@(.+)$/i)
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


