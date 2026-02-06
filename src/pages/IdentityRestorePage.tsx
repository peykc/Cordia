import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Upload, Loader2, Key, Shield } from 'lucide-react'
import { Button } from '../components/ui/button'
import { importIdentity } from '../lib/tauri'

function IdentityRestorePage() {
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayedText, setDisplayedText] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const navigate = useNavigate()
  
  const fullText = 'Restore Your Account'
  
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

  // Prevent default drag/drop behavior to stop files from opening
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('drop', handleDrop)
    }
  }, [])

  const processFile = async (file: File) => {
    setIsImporting(true)
    setError(null)

    try {
      const arrayBuffer = await file.arrayBuffer()
      const data = new Uint8Array(arrayBuffer)
      
      // Import identity (bootstrap command: creates account + sets session)
      const result = await importIdentity(data)
      
      // Restore profile data to localStorage if present
      if (result.profile_json) {
        const profileData = result.profile_json
        const accountId = result.identity.user_id
        const profileKey = `rmmt:profile:${accountId}`
        const profile: any = {
          display_name: profileData.display_name || null,
          avatar_data_url: profileData.avatar_data_url || null,
          avatar_rev: 0,
          real_name: profileData.real_name || null,
          show_real_name: profileData.show_real_name || false,
          updated_at: new Date().toISOString(),
        }
        localStorage.setItem(profileKey, JSON.stringify(profile))
      }
      
      // Reload to initialize AccountContext with new session
      window.location.href = '/home'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import account. The file may be corrupted or invalid.')
      setIsImporting(false)
    }
  }

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      await processFile(file)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = e.dataTransfer.files
    if (files && files.length > 0) {
      await processFile(files[0])
    }
  }

  return (
    <div className="h-full bg-background">
      <div className="container mx-auto px-6 py-12 max-w-4xl h-full relative">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/account/setup')}
          className="absolute top-12 left-6 h-0 w-12 z-10"
        >
          <ArrowLeft className="h-6 w-6" />
        </Button>
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
                Import your account from a previously exported backup file.
              </p>
            </div>
            <div className="space-y-4 text-sm text-muted-foreground font-light">
              <div className="flex items-start gap-3 fade-in" style={{ animationDelay: '0.2s' }}>
                <div className="w-1 h-1 bg-foreground/40 rounded-full mt-2"></div>
                <span className="flex items-center gap-2">
                  Original cryptographic keys preserved
                  <Shield className="h-3 w-3 opacity-60" />
                </span>
              </div>
              <div className="flex items-start gap-3 fade-in" style={{ animationDelay: '0.35s' }}>
                <div className="w-1 h-1 bg-foreground/40 rounded-full mt-2"></div>
                <span className="flex items-center gap-2">
                  Storage encrypted with this device's key
                  <Key className="h-3 w-3 opacity-60" />
                </span>
              </div>
            </div>
          </div>

          {/* Right side - Form */}
          <div className="flex items-center">
            <div className="bg-card/50 backdrop-blur-sm border border-border/50 p-8 space-y-6 w-full">
            <div className="space-y-2">
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center w-full h-48 border cursor-pointer transition-colors group ${
                  isDragging
                    ? 'border-solid border-foreground'
                    : 'border-dashed border-foreground/20 hover:border-solid hover:border-foreground active:border-solid active:border-foreground focus-within:border-solid focus-within:border-foreground'
                }`}
              >
                <label
                  htmlFor="file-input"
                  className="flex flex-col items-center justify-center w-full h-full cursor-pointer"
                >
                  <div className="flex flex-col items-center justify-center h-full">
                    <Upload className="w-8 h-8 mb-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    <p className="mb-1 text-sm text-muted-foreground group-hover:text-foreground transition-colors font-light">
                      Click to upload or drag and drop
                    </p>
                    <p className="text-xs text-muted-foreground/60 font-light">keys.roo file</p>
                  </div>
                  <input
                    id="file-input"
                    type="file"
                    className="hidden"
                    accept=".key,application/octet-stream"
                    onChange={handleFileSelect}
                    disabled={isImporting}
                  />
                </label>
              </div>
            </div>

            {error && (
              <div className="bg-destructive/10 border-l-2 border-destructive p-4 text-sm text-destructive">
                {error}
              </div>
            )}

            {isImporting && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground font-light">
                <Loader2 className="h-4 w-4 animate-spin" />
                Importing account...
              </div>
            )}

            <div className="bg-muted/30 border-l-2 border-foreground/20 p-4 text-xs text-muted-foreground font-light space-y-1">
              <p className="font-medium text-foreground/80">Note</p>
              <p>Your original keys are preserved. Only the storage encryption changes to match this device.</p>
            </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default IdentityRestorePage

