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
import { ServersProvider } from './contexts/ServersContext'
import { FriendsProvider } from './contexts/FriendsContext'
import { SidebarWidthProvider, useSidebarWidth } from './contexts/SidebarWidthContext'
import { ActiveServerProvider } from './contexts/ActiveServerContext'
import TitleBar from './components/TitleBar'
import { ServerSyncBootstrap } from './components/ServerSyncBootstrap'
import { AppUpdater } from './components/AppUpdater'
import { UserCard } from './components/UserCard'
import SplashPage from './pages/SplashPage'
import AccountSelectPage from './pages/AccountSelectPage'
import IdentitySetupPage from './pages/IdentitySetupPage'
import IdentityRestorePage from './pages/IdentityRestorePage'
import ServerListPage from './pages/ServerListPage'
import ServerViewPage from './pages/ServerViewPage'
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

  // Session exists but account data hasn't populated yet (should be brief)
  if (!identity) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading account...</p>
      </div>
    )
  }

  return <>{children}</>
}

function UserCardWrapper() {
  const { width } = useSidebarWidth()
  return (
    <div className="absolute bottom-0 left-0 z-10" style={{ width: `${width}em` }}>
      <UserCard />
    </div>
  )
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
                      <ServersProvider>
                        <FriendsProvider>
                        <SidebarWidthProvider>
                          <ActiveServerProvider>
                            <ServerSyncBootstrap />
                            <Router>
                    <div className="flex flex-col h-screen overflow-hidden border-2 border-foreground/20 relative">
                      <AppUpdater />
                      <TitleBar />
                      <div className="flex-1 overflow-auto min-h-0">
                        <Routes>
                          <Route path="/" element={<SplashPage />} />
                          <Route path="/account/select" element={<AccountSelectPage />} />
                          <Route path="/account/setup" element={<IdentitySetupPage />} />
                          <Route path="/account/restore" element={<IdentityRestorePage />} />
                          {/* Redirect old identity URLs to account URLs */}
                          <Route path="/identity/setup" element={<Navigate to="/account/setup" replace />} />
                          <Route path="/identity/restore" element={<Navigate to="/account/restore" replace />} />
                          <Route
                            path="/home"
                            element={
                              <ProtectedRoute>
                                <ServerListPage />
                              </ProtectedRoute>
                            }
                          />
                          <Route
                            path="/home/:serverId"
                            element={
                              <ProtectedRoute>
                                <ServerViewPage />
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
                      </div>
                      {/* Fixed UserCard at bottom left - same size on all pages */}
                      <UserCardWrapper />
                    </div>
                            </Router>
                          </ActiveServerProvider>
                        </SidebarWidthProvider>
                        </FriendsProvider>
                      </ServersProvider>
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

