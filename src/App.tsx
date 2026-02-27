import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { IdentityProvider, useIdentity } from './contexts/IdentityContext'
import { AccountProvider, useAccount } from './contexts/AccountContext'
import { BeaconProvider } from './contexts/BeaconContext'
import { PresenceProvider } from './contexts/PresenceContext'
import { VoicePresenceProvider } from './contexts/VoicePresenceContext'
import { SpeakingProvider } from './contexts/SpeakingContext'
import { ProfileProvider } from './contexts/ProfileContext'
import { RemoteProfilesProvider } from './contexts/RemoteProfilesContext'
import { WebRTCProvider } from './contexts/WebRTCContext'
import { ServersProvider } from './contexts/ServersContext'
import { FriendsProvider } from './contexts/FriendsContext'
import { EphemeralMessagesProvider } from './contexts/EphemeralMessagesContext'
import { ToastProvider } from './contexts/ToastContext'
import { SidebarWidthProvider } from './contexts/SidebarWidthContext'
import { ActiveServerProvider } from './contexts/ActiveServerContext'
import { SettingsModalProvider } from './contexts/SettingsModalContext'
import { TransferCenterModalProvider } from './contexts/TransferCenterModalContext'
import { NotificationsModalProvider } from './contexts/NotificationsModalContext'
import { MediaPreviewProvider, useMediaPreview } from './contexts/MediaPreviewContext'
import { VideoFullscreenProvider, useVideoFullscreen } from './contexts/VideoFullscreenContext'
import TitleBar from './components/TitleBar'
import { WindowResizeHandles } from './components/WindowResizeHandles'
import { ServerSyncBootstrap } from './components/ServerSyncBootstrap'
import { AppUpdater } from './components/AppUpdater'
import { SettingsModal } from './components/SettingsModal'
import { TransferCenterModal } from './components/TransferCenterModal'
import { NotificationsModal } from './components/NotificationsModal'
import { MediaPreviewModal } from './components/MediaPreviewModal'
import SplashPage from './pages/SplashPage'
import AccountSelectPage from './pages/AccountSelectPage'
import AccountSetupPage from './pages/AccountSetupPage'
import AccountRestorePage from './pages/AccountRestorePage'
import ServerListPage from './pages/ServerListPage'
import ServerViewPage from './pages/ServerViewPage'
import SettingsPage from './pages/SettingsPage'
import TransfersPage from './pages/TransfersPage'

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

function MediaPreviewRoot() {
  const { mediaPreview, setMediaPreview } = useMediaPreview()
  if (!mediaPreview) return null
  return (
    <MediaPreviewModal
      type={mediaPreview.type}
      url={mediaPreview.url}
      attachmentId={mediaPreview.attachmentId}
      fileName={mediaPreview.fileName}
      onClose={() => {
        if (mediaPreview.url?.startsWith('blob:')) URL.revokeObjectURL(mediaPreview.url)
        setMediaPreview(null)
      }}
    />
  )
}

function AppLayout() {
  const { isNativeVideoFullscreen } = useVideoFullscreen()
  return (
    <div className="flex flex-col h-screen overflow-hidden border-2 border-foreground/20 relative">
      {!isNativeVideoFullscreen && <WindowResizeHandles />}
      <AppUpdater />
      <TitleBar />
      <div className="relative z-40" aria-hidden>
        <MediaPreviewRoot />
      </div>
      <div className="flex-1 overflow-auto min-h-0 relative z-0">
        <Routes>
          <Route path="/" element={<SplashPage />} />
          <Route path="/account/select" element={<AccountSelectPage />} />
          <Route path="/account/setup" element={<AccountSetupPage />} />
          <Route path="/account/restore" element={<AccountRestorePage />} />
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
          <Route
            path="/transfers"
            element={
              <ProtectedRoute>
                <TransfersPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </div>
      <SettingsModal />
      <TransferCenterModal />
      <NotificationsModal />
    </div>
  )
}

function App() {
  return (
    <IdentityProvider>
      <AccountProvider>
        <BeaconProvider>
          <PresenceProvider>
            <VoicePresenceProvider>
              <SpeakingProvider>
                <RemoteProfilesProvider>
                  <ProfileProvider>
                    <WebRTCProvider>
                      <ServersProvider>
                        <FriendsProvider>
                        <EphemeralMessagesProvider>
                          <ToastProvider>
                          <SidebarWidthProvider>
                            <ActiveServerProvider>
                              <SettingsModalProvider>
                                <TransferCenterModalProvider>
                                <NotificationsModalProvider>
                                <MediaPreviewProvider>
                                <VideoFullscreenProvider>
                                <ServerSyncBootstrap />
                                <Router>
                                  <AppLayout />
                                </Router>
                                </VideoFullscreenProvider>
                                </MediaPreviewProvider>
                                </NotificationsModalProvider>
                                </TransferCenterModalProvider>
                              </SettingsModalProvider>
                            </ActiveServerProvider>
                          </SidebarWidthProvider>
                          </ToastProvider>
                        </EphemeralMessagesProvider>
                        </FriendsProvider>
                      </ServersProvider>
                    </WebRTCProvider>
                  </ProfileProvider>
                </RemoteProfilesProvider>
              </SpeakingProvider>
            </VoicePresenceProvider>
          </PresenceProvider>
        </BeaconProvider>
      </AccountProvider>
    </IdentityProvider>
  )
}

export default App

