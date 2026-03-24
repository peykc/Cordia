const SWARM_FLAG_STORAGE_KEY = 'cordia:feature:swarmTransfersV1'

function readBooleanFromStorage(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return null
    const normalized = raw.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false
    return null
  } catch {
    return null
  }
}

function readBooleanFromEnv(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export function isSwarmTransfersEnabled(): boolean {
  const fromStorage = readBooleanFromStorage(SWARM_FLAG_STORAGE_KEY)
  if (fromStorage != null) return fromStorage
  return readBooleanFromEnv((window as any).__CORDIA_SWARM_TRANSFERS_V1)
}

export function setSwarmTransfersEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SWARM_FLAG_STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // Ignore storage failures.
  }
}
