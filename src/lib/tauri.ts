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
}

export type ConnectionMode = 'Signaling' | 'DHT' | 'Manual'

export interface House {
  id: string
  name: string
  created_at: string
  rooms: Room[]
  members: HouseMember[]

  // P2P fields
  public_key: string
  invite_uri: string
  connection_mode: ConnectionMode
  signaling_url: string | null

  // Deprecated - kept for backward compatibility
  invite_code: string
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

export async function removeRoom(houseId: string, roomId: string): Promise<House> {
  return await invoke('remove_room', { houseId, roomId })
}

export async function checkSignalingServer(url?: string): Promise<boolean> {
  return await invoke('check_signaling_server', { url })
}

export async function getDefaultSignalingServer(): Promise<string> {
  return await invoke('get_default_signaling_server')
}
