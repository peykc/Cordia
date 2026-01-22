import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { IdentityProvider, useIdentity } from './contexts/IdentityContext'
import { AccountProvider, useAccount } from './contexts/AccountContext'
import { SignalingProvider } from './contexts/SignalingContext'
import { PresenceProvider } from './contexts/PresenceContext'
import { VoicePresenceProvider } from './contexts/VoicePresenceContext'
import { SpeakingProvider } from './contexts/SpeakingContext'
import { ProfileProvider } from './contexts/ProfileContext'
import { RemoteProfilesProvider } from './contexts/RemoteProfilesContext'
import { WebRTCProvider } from './contexts/WebRTCContext'
import TitleBar from './components/TitleBar'
import { HouseSyncBootstrap } from './components/HouseSyncBootstrap'
import SplashPage from './pages/SplashPage'
import AccountSelectPage from './pages/AccountSelectPage'
import IdentitySetupPage from './pages/IdentitySetupPage'
import IdentityRestorePage from './pages/IdentityRestorePage'
import HouseListPage from './pages/HouseListPage'
import HouseViewPage from './pages/HouseViewPage'
import SettingsPage from './pages/SettingsPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { identity } = useIdentity()
  const { isLoading, sessionLoaded, currentAccountId } = useAccount()

  // Wait for AccountContext to finish loading session + account list (+ identity load when session exists)
  if (isLoading || !sessionLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  // No active session => must explicitly select an account
  if (!currentAccountId) {
    return <Navigate to="/account/select" replace />
  }

  // Session exists but identity hasn't populated yet (should be brief)
  if (!identity) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading identity...</p>
      </div>
    )
  }

  return <>{children}</>
}

function App() {
  return (
    <IdentityProvider>
      <AccountProvider>
        <SignalingProvider>
          <PresenceProvider>
            <VoicePresenceProvider>
              <SpeakingProvider>
                <RemoteProfilesProvider>
                  <ProfileProvider>
                    <WebRTCProvider>
                  <HouseSyncBootstrap />
                  <div className="flex flex-col h-screen overflow-hidden border-2 border-foreground/20">
                    <TitleBar />
                    <div className="flex-1 overflow-auto min-h-0">
                      <Router>
                        <Routes>
                          <Route path="/" element={<SplashPage />} />
                          <Route path="/account/select" element={<AccountSelectPage />} />
                          <Route path="/identity/setup" element={<IdentitySetupPage />} />
                          <Route path="/identity/restore" element={<IdentityRestorePage />} />
                          <Route
                            path="/houses"
                            element={
                              <ProtectedRoute>
                                <HouseListPage />
                              </ProtectedRoute>
                            }
                          />
                          <Route
                            path="/houses/:houseId"
                            element={
                              <ProtectedRoute>
                                <HouseViewPage />
                              </ProtectedRoute>
                            }
                          />
                          <Route
                            path="/settings"
                            element={
                              <ProtectedRoute>
                                <SettingsPage />
                              </ProtectedRoute>
                            }
                          />
                        </Routes>
                      </Router>
                    </div>
                  </div>
                    </WebRTCProvider>
                  </ProfileProvider>
                </RemoteProfilesProvider>
              </SpeakingProvider>
            </VoicePresenceProvider>
          </PresenceProvider>
        </SignalingProvider>
      </AccountProvider>
    </IdentityProvider>
  )
}

export default App

