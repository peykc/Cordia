import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount } from './AccountContext'

export interface LocalProfile {
  display_name: string | null
  avatar_data_url: string | null
  avatar_rev: number
  real_name: string | null
  show_real_name: boolean
  updated_at: string | null
}

interface ProfileContextType {
  profile: LocalProfile
  saveProfileFields: (fields: { display_name: string | null; real_name: string | null; show_real_name: boolean }) => void
  setDisplayName: (name: string) => void
  setAvatarFromFile: (file: File) => Promise<void>
  setAvatarFromDataUrl: (dataUrl: string) => void
  clearAvatar: () => void
  setRealName: (name: string) => void
  setShowRealName: (show: boolean) => void
}

const ProfileContext = createContext<ProfileContextType | null>(null)

function storageKey(accountId: string | null) {
  return `rmmt:profile:${accountId || 'unknown'}`
}

async function fileToResizedWebpDataUrl(file: File, maxSize: number): Promise<string> {
  const blobUrl = URL.createObjectURL(file)
  try {
    let img: ImageBitmap | HTMLImageElement

    if ('createImageBitmap' in window) {
      img = await createImageBitmap(file)
    } else {
      img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('Failed to load image'))
        el.src = blobUrl
      })
    }

    const w = 'width' in img ? img.width : (img as any).width
    const h = 'height' in img ? img.height : (img as any).height
    const scale = Math.min(1, maxSize / Math.max(w, h))
    const outW = Math.max(1, Math.round(w * scale))
    const outH = Math.max(1, Math.round(h * scale))

    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No 2d canvas context')

    // Draw
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img as any, 0, 0, outW, outH)

    // Encode to WebP if possible; fallback to PNG dataURL.
    const webp = canvas.toDataURL('image/webp', 0.85)
    if (webp.startsWith('data:image/webp')) return webp
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { currentAccountId } = useAccount()
  const MAX_DISPLAY_NAME = 20
  const MAX_SECONDARY_NAME = 29
  const clamp = (s: string, max: number) => s.slice(0, max)
  const [profile, setProfile] = useState<LocalProfile>({
    display_name: null,
    avatar_data_url: null,
    avatar_rev: 0,
    real_name: null,
    show_real_name: false,
    updated_at: null,
  })

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey(currentAccountId))
      if (!raw) {
        setProfile({ display_name: null, avatar_data_url: null, avatar_rev: 0, real_name: null, show_real_name: false, updated_at: null })
        return
      }
      const parsed = JSON.parse(raw) as Partial<LocalProfile>
      setProfile({
        display_name: typeof parsed.display_name === 'string' ? parsed.display_name : null,
        avatar_data_url: typeof parsed.avatar_data_url === 'string' ? parsed.avatar_data_url : null,
        avatar_rev: typeof parsed.avatar_rev === 'number' ? parsed.avatar_rev : 0,
        real_name: typeof parsed.real_name === 'string' ? parsed.real_name : null,
        show_real_name: typeof parsed.show_real_name === 'boolean' ? parsed.show_real_name : false,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
      })
    } catch {
      setProfile({ display_name: null, avatar_data_url: null, avatar_rev: 0, real_name: null, show_real_name: false, updated_at: null })
    }
  }, [currentAccountId])

  const persist = (next: LocalProfile) => {
    setProfile(next)
    try {
      window.localStorage.setItem(storageKey(currentAccountId), JSON.stringify(next))
    } catch {
      // ignore
    }
  }

  const emitProfileUpdated = (next: LocalProfile) => {
    window.dispatchEvent(
      new CustomEvent('cordia:profile-updated', {
        detail: {
          display_name: next.display_name,
          real_name: next.real_name,
          show_real_name: next.show_real_name,
          updated_at: next.updated_at,
          avatar_data_url: next.avatar_data_url,
          avatar_rev: next.avatar_rev,
        },
      })
    )
  }

  const saveProfileFields: ProfileContextType['saveProfileFields'] = (fields) => {
    const display = fields.display_name ? clamp(fields.display_name.trim(), MAX_DISPLAY_NAME) : null
    const secondary = fields.real_name ? clamp(fields.real_name.trim(), MAX_SECONDARY_NAME) : null
    const next: LocalProfile = {
      display_name: display ? display : null,
      avatar_data_url: profile.avatar_data_url,
      avatar_rev: profile.avatar_rev,
      real_name: secondary ? secondary : null,
      show_real_name: fields.show_real_name,
      updated_at: new Date().toISOString(),
    }
    persist(next)
    emitProfileUpdated(next)
  }

  const setAvatarFromFile: ProfileContextType['setAvatarFromFile'] = async (file) => {
    // Basic safety: only accept images.
    if (!file.type.startsWith('image/')) throw new Error('Not an image')
    // Keep GIFs animated by storing them as-is (data URL) instead of drawing to canvas.
    // For other formats, resize + encode to WebP for consistency.
    const dataUrl =
      file.type === 'image/gif'
        ? await (async () => {
            // Basic cap to avoid accidentally storing huge GIFs in localStorage.
            // (Still no server upload; this is purely to keep the app responsive.)
            const maxBytes = 2 * 1024 * 1024
            if (file.size > maxBytes) throw new Error('GIF too large')
            return await fileToDataUrl(file)
          })()
        : await fileToResizedWebpDataUrl(file, 256)
    const next: LocalProfile = {
      display_name: profile.display_name ?? null,
      avatar_data_url: dataUrl,
      avatar_rev: (profile.avatar_rev || 0) + 1,
      real_name: profile.real_name ?? null,
      show_real_name: profile.show_real_name ?? false,
      updated_at: new Date().toISOString(),
    }
    persist(next)
    emitProfileUpdated(next)
  }

  const setAvatarFromDataUrl: ProfileContextType['setAvatarFromDataUrl'] = (dataUrl) => {
    const next: LocalProfile = {
      display_name: profile.display_name ?? null,
      avatar_data_url: dataUrl,
      avatar_rev: (profile.avatar_rev || 0) + 1,
      real_name: profile.real_name ?? null,
      show_real_name: profile.show_real_name ?? false,
      updated_at: new Date().toISOString(),
    }
    persist(next)
    emitProfileUpdated(next)
  }

  const clearAvatar = () => {
    const next: LocalProfile = {
      display_name: profile.display_name ?? null,
      avatar_data_url: null,
      avatar_rev: (profile.avatar_rev || 0) + 1,
      real_name: profile.real_name ?? null,
      show_real_name: profile.show_real_name ?? false,
      updated_at: new Date().toISOString(),
    }
    persist(next)
    emitProfileUpdated(next)
  }

  const setDisplayName: ProfileContextType['setDisplayName'] = (name) => {
    const cleaned = name.trim()
    saveProfileFields({
      display_name: cleaned ? cleaned : null,
      real_name: profile.real_name ?? null,
      show_real_name: profile.show_real_name ?? false,
    })
  }

  const setRealName: ProfileContextType['setRealName'] = (name) => {
    const cleaned = name.trim()
    saveProfileFields({
      display_name: profile.display_name ?? null,
      real_name: cleaned ? cleaned : null,
      show_real_name: profile.show_real_name ?? false,
    })
  }

  const setShowRealName: ProfileContextType['setShowRealName'] = (show) => {
    saveProfileFields({
      display_name: profile.display_name ?? null,
      real_name: profile.real_name ?? null,
      show_real_name: show,
    })
  }

  const value = useMemo(
    () => ({
      profile,
      saveProfileFields,
      setDisplayName,
      setAvatarFromFile,
      setAvatarFromDataUrl,
      clearAvatar,
      setRealName,
      setShowRealName,
    }),
    [profile]
  )

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

export function useProfile() {
  const ctx = useContext(ProfileContext)
  if (!ctx) {
    // In dev with HMR, it's possible to temporarily get a mismatched Context instance which would
    // otherwise hard-crash the whole app. Fall back to a safe no-op profile in dev.
    const isDev = Boolean((import.meta as any)?.env?.DEV)
    if (isDev) {
      console.warn('[Profile] useProfile called outside ProfileProvider (dev fallback). Try reloading the app.')
      return {
        profile: { display_name: null, avatar_data_url: null, avatar_rev: 0, real_name: null, show_real_name: false, updated_at: null },
        saveProfileFields: () => {},
        setDisplayName: () => {},
        setAvatarFromFile: async () => {},
        setAvatarFromDataUrl: () => {},
        clearAvatar: () => {},
        setRealName: () => {},
        setShowRealName: () => {},
      }
    }
    throw new Error('useProfile must be used within a ProfileProvider')
  }
  return ctx
}

