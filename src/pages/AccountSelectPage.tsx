import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccount } from '../contexts/AccountContext'
import type { CSSProperties } from 'react'
import { Plus, X, Download, Loader2 } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Tooltip } from '../components/Tooltip'
import { deleteAccount, exportFullIdentityForAccount } from '../lib/tauri'
import { useToast } from '../contexts/ToastContext'

function AccountSelectPage() {
  const { accounts, accountInfoMap, isLoading: accountsLoading, switchToAccount, authError, refreshAccounts } = useAccount()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    // If no accounts exist, redirect to setup
    if (!accountsLoading && accounts.length === 0) {
      navigate('/account/setup')
    }
  }, [accountsLoading, accounts, navigate])

  const handleSelectAccount = async (accountId: string) => {
    try {
      // Switch to the account (sets session AND loads identity)
      // AccountContext handles everything
      await switchToAccount(accountId)
      navigate('/home')
    } catch (error) {
      console.error('Failed to select account:', error)
      toast('Failed to select account. Please try again.')
    }
  }

  const handleCreateNew = () => {
    navigate('/account/setup')
  }

  const handleDeleteClick = (accountId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setDeleteTarget(accountId)
  }

  const sanitizeFilename = (name: string): string => {
    // Replace invalid filename chars with underscore
    return name.replace(/[/\\:*?"<>|]/g, '_')
  }

  const handleExportKeys = async () => {
    if (!deleteTarget) return

    setIsExporting(true)

    try {
      // Read profile from localStorage
      const profile = readLocalProfile(deleteTarget)
      const profileJson = profile ? {
        display_name: profile.display_name,
        real_name: profile.real_name,
        show_real_name: profile.show_real_name,
      } : null

      const data = await exportFullIdentityForAccount(deleteTarget, profileJson)
      
      // Generate filename: sanitized display_name from profile or account_info, fallback to user_id
      let filename: string
      const displayName = profile?.display_name || accountInfoMap[deleteTarget]?.display_name
      if (displayName) {
        const sanitized = sanitizeFilename(displayName)
        filename = sanitized || deleteTarget.slice(0, 16)
      } else {
        filename = deleteTarget.slice(0, 16)
      }
      
      // Create a blob and download it
      const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}.key`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to export account')
    } finally {
      setIsExporting(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return

    setIsDeleting(true)

    try {
      await deleteAccount(deleteTarget)
      await refreshAccounts()
      setDeleteTarget(null)
      
      // If no accounts remain, redirect to setup
      const updatedAccounts = accounts.filter(id => id !== deleteTarget)
      if (updatedAccounts.length === 0) {
        navigate('/account/setup')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete account')
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCancelDelete = () => {
    setDeleteTarget(null)
  }

  const readLocalProfile = (accountId: string) => {
    try {
      const raw = window.localStorage.getItem(`rmmt:profile:${accountId}`)
      if (!raw) return null
      const parsed = JSON.parse(raw) as {
        display_name?: string | null
        avatar_data_url?: string | null
        real_name?: string | null
        show_real_name?: boolean
      }
      return parsed
    } catch {
      return null
    }
  }

  const initialsFor = (name: string) => {
    const cleaned = name.replace(/[^a-zA-Z0-9\s]/g, '').trim()
    if (!cleaned) return '?'
    const parts = cleaned.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }

  const hashId = (s: string) => {
    let hash = 0
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
    return hash
  }

  const avatarStyleForUser = (userId: string): CSSProperties => {
    const h = hashId(userId) % 360
    return {
      backgroundColor: `hsl(${h}, 45%, 35%)`,
      color: '#fff',
    }
  }

  if (accountsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading accounts...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-10">
      <div className="w-full max-w-5xl space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Select Account</h1>
          <p className="text-sm text-muted-foreground">
            Choose a profile to continue or create a new one
          </p>
        </div>

        {authError && (
          <div className="bg-destructive/10 border-l-2 border-destructive p-3 text-sm text-destructive">
            {authError}
          </div>
        )}

        <div className="grid justify-start gap-2 [grid-template-columns:repeat(auto-fit,minmax(80px,80px))]">
          {accounts.map((accountId) => {
            const accountInfo = accountInfoMap[accountId]
            const profile = readLocalProfile(accountId)
            const displayName = profile?.display_name || accountInfo?.display_name || accountId
            const secondaryName = profile?.real_name || null
            const avatarDataUrl = profile?.avatar_data_url || null
            const created = accountInfo?.created_at
              ? new Date(accountInfo.created_at).toLocaleDateString()
              : 'Unknown'

            return (
              <div key={accountId} className="relative flex flex-col items-center group/account">
                <button
                  type="button"
                  onClick={() => handleSelectAccount(accountId)}
                  className="peer relative h-20 w-20 rounded-none border-2 border-border/40 overflow-hidden grid place-items-center transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 hover:border-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50"
                  style={!avatarDataUrl ? avatarStyleForUser(accountId) : undefined}
                >
                  {avatarDataUrl ? (
                    <img src={avatarDataUrl} alt={displayName} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-lg font-semibold">{initialsFor(displayName)}</span>
                  )}

                  <Tooltip content="Delete account" side="bottom">
                    <button
                      type="button"
                      onClick={(e) => handleDeleteClick(accountId, e)}
                      className="absolute top-1 right-1 h-5 w-5 rounded-none bg-destructive/90 hover:bg-destructive text-white opacity-0 group-hover/account:opacity-100 transition-opacity duration-200 flex items-center justify-center"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Tooltip>

                  <div className="absolute left-1/2 top-full mt-2 -translate-x-1/2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none z-20">
                    <div className="bg-popover border-2 border-border rounded-none shadow-lg p-3 space-y-1 text-xs text-muted-foreground whitespace-nowrap">
                      <div className="text-sm font-semibold text-foreground">{displayName}</div>
                      {secondaryName && (
                        <div>Secondary Name: <span className="text-foreground/90">{secondaryName}</span></div>
                      )}
                      <div>Account ID: <span className="text-foreground/90">{accountId}</span></div>
                      <div>Created: <span className="text-foreground/90">{created}</span></div>
                    </div>
                  </div>
                </button>

                <div className="absolute left-1/2 top-full mt-2 -translate-x-1/2 opacity-0 invisible peer-hover:opacity-100 peer-hover:visible transition-all duration-200 pointer-events-none z-20">
                  <div className="bg-popover border-2 border-border rounded-md shadow-lg px-2 py-1 whitespace-nowrap">
                    <div className="text-sm font-semibold text-foreground text-center">{displayName}</div>
                  </div>
                </div>
              </div>
            )
          })}

          <div className="relative flex flex-col items-center">
            <button
              type="button"
              onClick={handleCreateNew}
              className="peer relative h-20 w-20 rounded-none border-2 border-border/40 grid place-items-center text-foreground/70 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 hover:border-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50"
            >
              <Plus className="h-8 w-8" />
            </button>
            <div className="absolute left-1/2 top-full mt-2 -translate-x-1/2 opacity-0 invisible peer-hover:opacity-100 peer-hover:visible transition-all duration-200 pointer-events-none z-20">
              <div className="bg-popover border-2 border-border rounded-md shadow-lg px-2 py-1 whitespace-nowrap">
                <div className="text-sm font-semibold text-foreground text-center">Create New Account</div>
              </div>
            </div>
          </div>
        </div>

        {deleteTarget && (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <div className="bg-card border-2 border-border rounded-lg p-6 max-w-md w-full space-y-6">
              <div className="space-y-2">
                <h2 className="text-xl font-light tracking-tight">Delete Account</h2>
                <div className="h-px bg-foreground/20 w-full"></div>
              </div>

              <div className="space-y-4">
                <p className="text-sm text-muted-foreground font-light">
                  This will permanently delete the account and all its data. This action cannot be undone.
                </p>

                <div className="bg-amber-500/10 border-l-2 border-amber-500/70 p-4 text-sm">
                  <p className="text-foreground font-semibold mb-2">⚠️ Important: Download Your Keys First</p>
                  <p className="text-muted-foreground font-light">
                    Before deleting, download your account keys. You can use them to restore this account on another device or after reinstallation.
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={handleExportKeys}
                    disabled={isExporting || isDeleting}
                    className="flex-1 font-light"
                  >
                    {isExporting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Exporting...
                      </>
                    ) : (
                      <>
                        <Download className="mr-2 h-4 w-4" />
                        Download Keys
                      </>
                    )}
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleConfirmDelete}
                    disabled={isExporting || isDeleting}
                    className="flex-1 font-light border-destructive/50 text-destructive hover:bg-destructive/10"
                  >
                    {isDeleting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      'Delete Account'
                    )}
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleCancelDelete}
                    disabled={isExporting || isDeleting}
                    className="font-light"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default AccountSelectPage
