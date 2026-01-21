import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

type VoicePresenceByHouse = Record<string, Record<string, Set<string>>> // signing_pubkey -> room_id -> Set of user_ids

interface VoicePresenceContextType {
  getVoiceParticipants: (signingPubkey: string, roomId: string) => string[]  // Returns user_ids in voice for a room
  applyUpdate: (signingPubkey: string, userId: string, roomId: string, inVoice: boolean) => void
  applySnapshot: (signingPubkey: string, roomId: string, userIds: string[]) => void
}

const VoicePresenceContext = createContext<VoicePresenceContextType | null>(null)

export function VoicePresenceProvider({ children }: { children: ReactNode }) {
  const [byHouse, setByHouse] = useState<VoicePresenceByHouse>({})

  const applyUpdate: VoicePresenceContextType['applyUpdate'] = (signingPubkey, userId, roomId, inVoice) => {
    setByHouse((prev) => {
      const house = prev[signingPubkey] || {}
      const room = house[roomId] || new Set<string>()

      if (inVoice) {
        // Add user to voice
        const updatedRoom = new Set(room)
        updatedRoom.add(userId)
        return {
          ...prev,
          [signingPubkey]: {
            ...house,
            [roomId]: updatedRoom,
          },
        }
      } else {
        // Remove user from voice
        if (!room.has(userId)) return prev
        const updatedRoom = new Set(room)
        updatedRoom.delete(userId)
        
        // Clean up empty rooms
        const updatedHouse = { ...house }
        if (updatedRoom.size === 0) {
          delete updatedHouse[roomId]
        } else {
          updatedHouse[roomId] = updatedRoom
        }
        
        // Clean up empty houses
        if (Object.keys(updatedHouse).length === 0) {
          const { [signingPubkey]: _, ...rest } = prev
          return rest
        }
        
        return {
          ...prev,
          [signingPubkey]: updatedHouse,
        }
      }
    })
  }

  const applySnapshot: VoicePresenceContextType['applySnapshot'] = (signingPubkey, roomId, userIds) => {
    setByHouse((prev) => {
      const house = prev[signingPubkey] || {}
      return {
        ...prev,
        [signingPubkey]: {
          ...house,
          [roomId]: new Set(userIds),
        },
      }
    })
  }

  const getVoiceParticipants: VoicePresenceContextType['getVoiceParticipants'] = (signingPubkey, roomId) => {
    const house = byHouse[signingPubkey]
    if (!house) return []
    const room = house[roomId]
    if (!room) return []
    return Array.from(room)
  }

  const value = useMemo(
    () => ({ applyUpdate, applySnapshot, getVoiceParticipants }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byHouse]
  )

  return <VoicePresenceContext.Provider value={value}>{children}</VoicePresenceContext.Provider>
}

export function useVoicePresence() {
  const ctx = useContext(VoicePresenceContext)
  if (!ctx) throw new Error('useVoicePresence must be used within a VoicePresenceProvider')
  return ctx
}
