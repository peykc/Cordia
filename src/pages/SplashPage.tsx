import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useIdentity } from '../contexts/IdentityContext'

function SplashPage() {
  const { isLoading, hasStoredIdentity, identity } = useIdentity()
  const navigate = useNavigate()

  useEffect(() => {
    if (!isLoading) {
      if (identity) {
        // Identity loaded successfully, go to houses
        navigate('/houses')
      } else if (hasStoredIdentity) {
        // Identity file exists but failed to load (corrupted)
        // Still go to setup, user can restore
        navigate('/identity/setup')
      } else {
        // No identity, go to setup
        navigate('/identity/setup')
      }
    }
  }, [isLoading, hasStoredIdentity, identity, navigate])

  return (
    <div className="h-full bg-background grid-pattern flex items-center justify-center">
      <div className="flex flex-col items-start gap-6 px-8">
        <div className="flex items-center gap-3">
          <div className="w-px h-12 bg-foreground/20"></div>
          <div>
            <h1 className="text-5xl font-light tracking-tight text-foreground">Roommate</h1>
            <div className="h-px w-24 bg-foreground/10 mt-2"></div>
          </div>
        </div>
        <p className="text-muted-foreground text-sm font-light tracking-wide uppercase">
          {isLoading ? 'Initializing' : 'Preparing'}
        </p>
      </div>
    </div>
  )
}

export default SplashPage
