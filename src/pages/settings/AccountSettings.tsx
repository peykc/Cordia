import { Key, EyeOff } from 'lucide-react'
import { useIdentity } from '../../contexts/IdentityContext'
import { useProfile } from '../../contexts/ProfileContext'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AvatarCropModal } from '../../components/AvatarCropModal'

export function AccountSettings() {
  const { identity } = useIdentity()
  const { profile, setAvatarFromFile, setAvatarFromDataUrl, clearAvatar, saveProfileFields } = useProfile()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [avatarError, setAvatarError] = useState('')
  const [revealUserId, setRevealUserId] = useState(false)
  const [revealPublicKey, setRevealPublicKey] = useState(false)
  const [pendingCropUrl, setPendingCropUrl] = useState<string | null>(null)

  const MAX_DISPLAY_NAME = 20
  const MAX_SECONDARY_NAME = 29
  const clamp = (s: string, max: number) => s.slice(0, max)

  // Draft fields (save-once instead of persisting on every keystroke)
  const currentDisplayName = clamp(profile.display_name ?? identity?.display_name ?? '', MAX_DISPLAY_NAME)
  const currentRealName = clamp(profile.real_name ?? '', MAX_SECONDARY_NAME)
  const currentShowRealName = Boolean(profile.show_real_name)

  const [draftDisplayName, setDraftDisplayName] = useState(currentDisplayName)
  const [draftRealName, setDraftRealName] = useState(currentRealName)
  const [draftShowRealName, setDraftShowRealName] = useState(currentShowRealName)
  const [saveMessage, setSaveMessage] = useState('')

  // Keep drafts in sync when switching accounts / loading, but don't stomp user edits.
  useEffect(() => {
    setDraftDisplayName(currentDisplayName)
    setDraftRealName(currentRealName)
    setDraftShowRealName(currentShowRealName)
    setSaveMessage('')
    if (pendingCropUrl) {
      URL.revokeObjectURL(pendingCropUrl)
      setPendingCropUrl(null)
    }
  }, [identity?.user_id])

  // Revoke pending object URLs on change/unmount
  useEffect(() => {
    return () => {
      if (pendingCropUrl) URL.revokeObjectURL(pendingCropUrl)
    }
  }, [pendingCropUrl])

  const isDirty = useMemo(() => {
    const norm = (s: string) => s.trim()
    return (
      norm(draftDisplayName) !== norm(currentDisplayName) ||
      norm(draftRealName) !== norm(currentRealName) ||
      draftShowRealName !== currentShowRealName
    )
  }, [draftDisplayName, draftRealName, draftShowRealName, currentDisplayName, currentRealName, currentShowRealName])

  const handleSaveProfile = () => {
    const nextDisplay = clamp(draftDisplayName.trim(), MAX_DISPLAY_NAME)
    const nextSecondary = clamp(draftRealName.trim(), MAX_SECONDARY_NAME)
    saveProfileFields({
      display_name: nextDisplay ? nextDisplay : null,
      real_name: nextSecondary ? nextSecondary : null,
      show_real_name: Boolean(draftShowRealName),
    })
    setSaveMessage('Saved.')
    setTimeout(() => setSaveMessage(''), 1500)
  }

  return (
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 space-y-6">
      <div className="space-y-1">
        <div className="inline-block">
          <h2 className="text-lg font-light tracking-tight">Account</h2>
          <div className="h-px bg-foreground/20 mt-1 w-full"></div>
        </div>
        <p className="text-xs text-muted-foreground font-light">Your account information</p>
      </div>
      <div className="space-y-6 pt-4">
        <div className="grid grid-cols-1 md:grid-cols-[1.6fr_1fr] gap-8 items-start">
          {/* Names (left) */}
          <div className="space-y-6">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Display Name</p>
              <Input
                value={draftDisplayName}
                maxLength={MAX_DISPLAY_NAME}
                onChange={(e) => {
                  setDraftDisplayName(clamp(e.target.value, MAX_DISPLAY_NAME))
                  setSaveMessage('')
                }}
                placeholder="Display name"
                className="h-11 font-light"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Secondary Name (optional)
              </Label>
              <Input
                value={draftRealName}
                maxLength={MAX_SECONDARY_NAME}
                onChange={(e) => {
                  setDraftRealName(clamp(e.target.value, MAX_SECONDARY_NAME))
                  setSaveMessage('')
                }}
                placeholder="Secondary name"
                className="h-11 font-light"
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground font-light select-none">
                <input
                  type="checkbox"
                  checked={draftShowRealName}
                  onChange={(e) => {
                    setDraftShowRealName(e.target.checked)
                    setSaveMessage('')
                  }}
                />
                Reveal on profile
              </label>
            </div>
          </div>

          {/* Profile picture (right) */}
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Profile Picture</p>
            <div className="flex items-center gap-4">
              {profile.avatar_data_url ? (
                <img
                  src={profile.avatar_data_url}
                  alt="Profile"
                  className="h-20 w-20 border-2 border-border rounded-none object-cover"
                />
              ) : (
                <div className="h-20 w-20 border-2 border-border rounded-none grid place-items-center text-xs font-mono text-muted-foreground">
                  —
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setAvatarError('')
                    try {
                      // GIFs: keep animated, no cropping.
                      if (file.type === 'image/gif') {
                        await setAvatarFromFile(file)
                        return
                      }

                      // Everything else: show crop modal using object URL.
                      const url = URL.createObjectURL(file)
                      // Revoke previous pending URL if any
                      if (pendingCropUrl) URL.revokeObjectURL(pendingCropUrl)
                      setPendingCropUrl(url)
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : ''
                      setAvatarError(
                        msg === 'GIF too large'
                          ? 'That GIF is too large. Please choose a smaller one (max 2MB).'
                          : 'Failed to set avatar. Please try a different image.'
                      )
                    } finally {
                      // allow re-selecting the same file
                      e.target.value = ''
                    }
                  }}
                />
                <div className="flex flex-col gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 font-light"
                    onClick={() => fileRef.current?.click()}
                  >
                    Choose…
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 font-light"
                    onClick={clearAvatar}
                    disabled={!profile.avatar_data_url}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </div>
            {avatarError && <p className="text-xs text-red-500">{avatarError}</p>}
            <p className="text-xs text-muted-foreground font-light">Stored locally on this device (for now).</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            className="h-9 font-light bg-foreground text-background hover:bg-foreground/90"
            onClick={handleSaveProfile}
            disabled={!isDirty}
          >
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 font-light"
            onClick={() => {
              setDraftDisplayName(currentDisplayName)
              setDraftRealName(currentRealName)
              setDraftShowRealName(currentShowRealName)
              setSaveMessage('')
            }}
            disabled={!isDirty}
          >
            Reset
          </Button>
          {saveMessage && <span className="text-xs text-muted-foreground font-light">{saveMessage}</span>}
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">User ID</p>
          <button
            type="button"
            onClick={() => setRevealUserId(v => !v)}
            className="w-full text-left"
          >
            <div className="relative inline-block min-w-[25ch] max-w-full w-fit">
              <p
                className={`text-xs font-mono break-all font-light ${
                  revealUserId ? 'text-muted-foreground' : 'text-muted-foreground/80 blur-sm select-none'
                }`}
              >
                {identity?.user_id || 'Unknown'}
              </p>
              {!revealUserId && (
                <div className="absolute inset-0 grid place-items-center">
                  <span className="text-[11px] text-black font-light bg-white px-2 py-0.5 rounded-sm flex items-center gap-1.5">
                    <EyeOff className="h-3 w-3" strokeWidth={2} />
                    Reveal
                  </span>
                </div>
              )}
            </div>
          </button>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Key className="h-3 w-3" />
            Public Key
          </p>
          <button
            type="button"
            onClick={() => setRevealPublicKey(v => !v)}
            className="w-full text-left"
          >
            <div className="relative inline-block min-w-[25ch] max-w-full w-fit">
              <p
                className={`text-xs font-mono break-all font-light ${
                  revealPublicKey ? 'text-muted-foreground' : 'text-muted-foreground/80 blur-sm select-none'
                }`}
              >
                {identity?.public_key || 'Unknown'}
              </p>
              {!revealPublicKey && (
                <div className="absolute inset-0 grid place-items-center">
                  <span className="text-[11px] text-black font-light bg-white px-2 py-0.5 rounded-sm flex items-center gap-1.5">
                    <EyeOff className="h-3 w-3" strokeWidth={2} />
                    Reveal
                  </span>
                </div>
              )}
            </div>
          </button>
        </div>
      </div>

      {pendingCropUrl && (
        <AvatarCropModal
          imageSrc={pendingCropUrl}
          onCancel={() => {
            URL.revokeObjectURL(pendingCropUrl)
            setPendingCropUrl(null)
          }}
          onSave={(dataUrl) => {
            try {
              setAvatarFromDataUrl(dataUrl)
              URL.revokeObjectURL(pendingCropUrl)
              setPendingCropUrl(null)
            } catch {
              setAvatarError('Failed to set avatar. Please try a different image.')
              URL.revokeObjectURL(pendingCropUrl)
              setPendingCropUrl(null)
            }
          }}
        />
      )}
    </div>
  )
}




