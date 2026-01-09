import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { IdentityProvider, useIdentity } from './contexts/IdentityContext'
import { SignalingProvider } from './contexts/SignalingContext'
import TitleBar from './components/TitleBar'
import SplashPage from './pages/SplashPage'
import IdentitySetupPage from './pages/IdentitySetupPage'
import IdentityRestorePage from './pages/IdentityRestorePage'
import HouseListPage from './pages/HouseListPage'
import HouseViewPage from './pages/HouseViewPage'
import SettingsPage from './pages/SettingsPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { identity, isLoading } = useIdentity()

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (!identity) {
    return <Navigate to="/identity/setup" replace />
  }

  return <>{children}</>
}

function App() {
  return (
    <IdentityProvider>
      <SignalingProvider>
        <div className="flex flex-col h-screen overflow-hidden border-2 border-foreground/20">
          <TitleBar />
          <div className="flex-1 overflow-auto min-h-0">
            <Router>
              <Routes>
                <Route path="/" element={<SplashPage />} />
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
      </SignalingProvider>
    </IdentityProvider>
  )
}

export default App

