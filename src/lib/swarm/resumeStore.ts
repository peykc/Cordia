import {
  loadDownloadResumeState,
  saveDownloadResumeState,
  clearDownloadResumeState,
  type DownloadResumeState,
} from '../tauri'
import type { SwarmResumeState } from './types'

const FALLBACK_KEY_PREFIX = 'cordia:swarm-resume'

function fallbackKey(requestId: string): string {
  return `${FALLBACK_KEY_PREFIX}:${requestId}`
}

function toTauriState(state: SwarmResumeState): DownloadResumeState {
  return {
    swarm_key: state.swarm_key,
    sha256: state.sha256 ?? null,
    piece_size: state.piece_size,
    piece_count: state.piece_count,
    bitfield: state.bitfield,
    target_path: state.target_path,
    updated_at: state.updated_at,
  }
}

function fromTauriState(state: DownloadResumeState): SwarmResumeState {
  return {
    swarm_key: state.swarm_key,
    sha256: state.sha256 ?? null,
    piece_size: state.piece_size,
    piece_count: state.piece_count,
    bitfield: state.bitfield ?? [],
    target_path: state.target_path,
    updated_at: state.updated_at,
  }
}

export class ResumeStore {
  async load(requestId: string): Promise<SwarmResumeState | null> {
    try {
      const state = await loadDownloadResumeState(requestId)
      if (state) return fromTauriState(state)
    } catch {
      // Fall through to localStorage fallback.
    }
    try {
      const raw = window.localStorage.getItem(fallbackKey(requestId))
      return raw ? (JSON.parse(raw) as SwarmResumeState) : null
    } catch {
      return null
    }
  }

  async save(requestId: string, state: SwarmResumeState): Promise<void> {
    try {
      await saveDownloadResumeState(requestId, toTauriState(state))
    } catch {
      // Keep a local fallback for environments where native command is unavailable.
    }
    try {
      window.localStorage.setItem(fallbackKey(requestId), JSON.stringify(state))
    } catch {
      // Ignore persistence failures.
    }
  }

  async clear(requestId: string): Promise<void> {
    try {
      await clearDownloadResumeState(requestId)
    } catch {
      // Ignore native cleanup errors.
    }
    try {
      window.localStorage.removeItem(fallbackKey(requestId))
    } catch {
      // Ignore storage cleanup errors.
    }
  }
}
