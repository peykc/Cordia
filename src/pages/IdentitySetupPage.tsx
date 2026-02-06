import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Key, WifiOff, Download } from 'lucide-react'
import { Button } from '../components/ui/button'
import { createIdentity } from '../lib/tauri'

function IdentitySetupPage() {
  const [displayName, setDisplayName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayedText, setDisplayedText] = useState('')
  const navigate = useNavigate()
  
  const fullText = 'Create Your Account'
  
  useEffect(() => {
    let currentIndex = 0
    const typingSpeed = 50
    
    const typeInterval = setInterval(() => {
      if (currentIndex < fullText.length) {
        setDisplayedText(fullText.slice(0, currentIndex + 1))
        currentIndex++
      } else {
        clearInterval(typeInterval)
      }
    }, typingSpeed)
    
    return () => clearInterval(typeInterval)
  }, [])

  const handleCreate = async () => {
    if (!displayName.trim()) {
      setError('Please enter a display name')
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      // Create identity (also creates account and sets session)
      await createIdentity(displayName.trim())
      
      // Reload to initialize AccountContext with new session
      window.location.href = '/home'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account')
      setIsCreating(false)
    }
  }

  return (
    <div className="h-full bg-background">
      <div className="container mx-auto px-6 py-12 max-w-4xl h-full">
        <div className="grid md:grid-cols-2 gap-12 h-full">
          {/* Left side - Info */}
          <div className="space-y-8 pt-8">
            <div>
              <div className="mb-6">
                <h1 className="text-4xl font-light tracking-tight">
                  {displayedText}
                  {displayedText.length < fullText.length && (
                    <span className="opacity-50 animate-blink">|</span>
                  )}
                </h1>
              </div>
              <p className="text-muted-foreground text-base leading-relaxed max-w-sm fade-in">
                <span className="font-semibold text-foreground">Real-time P2P communication,<br /> decentralized and encrypted</span><br /><br />Your account is stored locally on this device. <br />No passwords, no history, no central servers.
              </p>
            </div>
            <div className="space-y-4 text-sm text-muted-foreground font-light">
              <div className="flex items-start gap-3 fade-in" style={{ animationDelay: '0.2s' }}>
                <div className="w-1 h-1 bg-foreground/40 rounded-full mt-2"></div>
                <span className="flex items-center gap-2">
                  Encrypted with device key
                  <Key className="h-3 w-3 opacity-60" />
                </span>
              </div>
              <div className="flex items-start gap-3 fade-in" style={{ animationDelay: '0.35s' }}>
                <div className="w-1 h-1 bg-foreground/40 rounded-full mt-2"></div>
                <span className="flex items-center gap-2">
                  Fully offline operation
                  <WifiOff className="h-3 w-3 opacity-60" />
                </span>
              </div>
              <div className="flex items-start gap-3 fade-in" style={{ animationDelay: '0.5s' }}>
                <div className="w-1 h-1 bg-foreground/40 rounded-full mt-2"></div>
                <span className="flex items-center gap-2">
                  Exportable for backup
                  <Download className="h-3 w-3 opacity-60" />
                </span>
              </div>
            </div>
          </div>

          {/* Right side - Form */}
          <div className="flex items-center">
            <div className="bg-card/50 backdrop-blur-sm border border-border/50 p-8 space-y-6 w-full">
            <div className="space-y-3">
              <label htmlFor="displayName" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Display Name
              </label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreate()
                  }
                }}
                placeholder="Enter your name"
                className="w-full bg-secondary/50 border-0 border-b-2 border-foreground/30 px-0 py-3 text-base focus:outline-none focus:border-foreground transition-colors placeholder:text-muted-foreground/40"
                disabled={isCreating}
                autoFocus
              />
            </div>

            {error && (
              <div className="bg-destructive/10 border-l-2 border-destructive p-4 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-3 pt-4">
              <Button
                onClick={handleCreate}
                disabled={isCreating || !displayName.trim()}
                className="w-full bg-foreground text-background hover:bg-foreground/90 h-11 font-light tracking-wide"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Continue'
                )}
              </Button>

              <Button
                variant="ghost"
                onClick={() => navigate('/account/restore')}
                className="w-full h-11 font-light text-muted-foreground hover:text-foreground"
                disabled={isCreating}
              >
                Restore from backup
              </Button>
            </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default IdentitySetupPage

