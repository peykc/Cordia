import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useIdentity } from '../contexts/IdentityContext'
import { useAccount } from '../contexts/AccountContext'

function SplashPage() {
  const { identity } = useIdentity()
  const { isLoading: accountsLoading, accounts, currentAccountId } = useAccount()
  const navigate = useNavigate()

  useEffect(() => {
    // Wait for AccountContext to load
    if (accountsLoading) {
      return
    }

    // Session state is the ONLY authority for login
    if (currentAccountId && identity) {
      // Active session with identity loaded - go to main app
        navigate('/home')
    } else if (accounts.length > 0) {
      // Accounts exist but no active session - show account selector (login screen)
      navigate('/account/select')
      } else {
      // No accounts exist - show setup to create first account
        navigate('/account/setup')
    }
  }, [accountsLoading, currentAccountId, identity, accounts, navigate])

  return (
    <div className="h-full bg-background flex items-center justify-center">
      <div className="flex flex-col items-start gap-6 px-8">
        <div className="flex items-center gap-3">
          <div className="w-px h-12 bg-foreground/20"></div>
          <div>
            <h1 className="text-5xl font-light tracking-tight text-foreground">Cordia</h1>
            <div className="h-px w-24 bg-foreground/10 mt-2"></div>
          </div>
        </div>
        <p className="text-muted-foreground text-sm font-light tracking-wide uppercase">
          {accountsLoading ? 'Loading' : 'Preparing'}
        </p>
      </div>
    </div>
  )
}

export default SplashPage
