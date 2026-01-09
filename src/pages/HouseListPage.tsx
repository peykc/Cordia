import { Link, useNavigate } from 'react-router-dom'
import { Plus, Settings, Users } from 'lucide-react'
import { Button } from '../components/ui/button'
import { useEffect, useState } from 'react'
import { listHouses, createHouse, findHouseByInvite, joinHouse, type House } from '../lib/tauri'
import { useIdentity } from '../contexts/IdentityContext'

function HouseListPage() {
  const navigate = useNavigate()
  const { identity } = useIdentity()
  const [houses, setHouses] = useState<House[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showJoinDialog, setShowJoinDialog] = useState(false)
  const [houseName, setHouseName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [joinError, setJoinError] = useState('')

  useEffect(() => {
    loadHouses()
  }, [])

  const loadHouses = async () => {
    try {
      const loadedHouses = await listHouses()
      setHouses(loadedHouses)
    } catch (error) {
      console.error('Failed to load houses:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCreateHouse = async () => {
    if (!identity || !houseName.trim()) return

    setIsCreating(true)
    try {
      const newHouse = await createHouse(
        houseName.trim(),
        identity.user_id,
        identity.display_name
      )
      setHouses([...houses, newHouse])
      setShowCreateDialog(false)
      setHouseName('')
      navigate(`/houses/${newHouse.id}`)
    } catch (error) {
      console.error('Failed to create house:', error)
    } finally {
      setIsCreating(false)
    }
  }

  const handleJoinHouse = async () => {
    if (!identity || !inviteCode.trim()) return

    const code = inviteCode.trim().toUpperCase()
    setJoinError('')
    setIsCreating(true)

    try {
      // Find house by invite code
      const matchingHouse = await findHouseByInvite(code)

      if (matchingHouse) {
        // Check if already a member
        if (matchingHouse.members.some(m => m.user_id === identity.user_id)) {
          setJoinError('You are already a member of this house')
          setIsCreating(false)
          return
        }

        // Add user as member
        const updatedHouse = await joinHouse(
          matchingHouse.id,
          identity.user_id,
          identity.display_name
        )

        // Update local state
        const existingHouse = houses.find(h => h.id === updatedHouse.id)
        if (!existingHouse) {
          setHouses([...houses, updatedHouse])
        }

        setShowJoinDialog(false)
        setInviteCode('')
        navigate(`/houses/${updatedHouse.id}`)
      } else {
        setJoinError('Invalid invite code. House not found.')
      }
    } catch (error) {
      console.error('Failed to join house:', error)
      setJoinError('Failed to join house. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }

  if (isLoading) {
    return (
      <div className="h-full bg-background grid-pattern flex items-center justify-center">
        <p className="text-muted-foreground text-sm font-light">Loading houses...</p>
      </div>
    )
  }

  return (
    <div className="h-full bg-background grid-pattern flex flex-col">
      <header className="border-b-2 border-border">
        <div className="container flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <div className="w-px h-6 bg-foreground/20"></div>
            <h1 className="text-sm font-light tracking-wider uppercase">Houses</h1>
          </div>
          <Link to="/settings">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <Settings className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-8">
        {houses.length === 0 ? (
          <div className="max-w-md w-full space-y-8">
            <div className="space-y-4">
              <div className="w-12 h-px bg-foreground/20"></div>
              <h2 className="text-2xl font-light tracking-tight">No houses</h2>
              <p className="text-muted-foreground text-sm leading-relaxed font-light">
                Create or join a house to start voice chatting with your roommates.
              </p>
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => setShowCreateDialog(true)}
                className="flex-1 bg-foreground text-background hover:bg-foreground/90 h-11 font-light tracking-wide"
              >
                <Plus className="mr-2 h-4 w-4" />
                Create House
              </Button>
              <Button
                onClick={() => setShowJoinDialog(true)}
                variant="outline"
                className="flex-1 h-11 font-light tracking-wide"
              >
                Join House
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-w-2xl w-full space-y-6">
            <div className="flex items-center justify-between">
              <div className="w-12 h-px bg-foreground/20"></div>
              <div className="flex gap-2">
                <Button
                  onClick={() => setShowJoinDialog(true)}
                  variant="outline"
                  size="sm"
                  className="h-9 font-light"
                >
                  Join House
                </Button>
                <Button
                  onClick={() => setShowCreateDialog(true)}
                  size="sm"
                  className="bg-foreground text-background hover:bg-foreground/90 h-9 font-light"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New House
                </Button>
              </div>
            </div>
            <div className="grid gap-4">
              {houses.map((house) => (
                <button
                  key={house.id}
                  onClick={() => navigate(`/houses/${house.id}`)}
                  className="p-6 border-2 border-border bg-card hover:bg-accent/50 transition-colors text-left rounded-lg"
                >
                  <div className="flex items-start justify-between">
                    <div className="space-y-2">
                      <h3 className="text-lg font-light tracking-tight">{house.name}</h3>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {house.members.length} {house.members.length === 1 ? 'member' : 'members'}
                        </span>
                        <span>{house.rooms.length} {house.rooms.length === 1 ? 'room' : 'rooms'}</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      {showCreateDialog && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border-2 border-border rounded-lg p-6 max-w-md w-full space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-light tracking-tight">Create House</h2>
              <div className="w-8 h-px bg-foreground/20"></div>
            </div>
            <div className="space-y-2">
              <label htmlFor="house-name" className="text-sm text-muted-foreground font-light">
                House Name
              </label>
              <input
                id="house-name"
                type="text"
                value={houseName}
                onChange={(e) => setHouseName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreateHouse()
                  } else if (e.key === 'Escape') {
                    setShowCreateDialog(false)
                  }
                }}
                placeholder="My House"
                className="w-full px-4 py-2 bg-background border border-border rounded-md text-sm font-light focus:outline-none focus:ring-2 focus:ring-primary"
                autoFocus
              />
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  setShowCreateDialog(false)
                  setHouseName('')
                }}
                variant="outline"
                className="flex-1 h-10 font-light"
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateHouse}
                className="flex-1 h-10 bg-foreground text-background hover:bg-foreground/90 font-light"
                disabled={isCreating || !houseName.trim()}
              >
                {isCreating ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showJoinDialog && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border-2 border-border rounded-lg p-6 max-w-md w-full space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-light tracking-tight">Join House</h2>
              <div className="w-8 h-px bg-foreground/20"></div>
            </div>
            <div className="space-y-2">
              <label htmlFor="invite-code" className="text-sm text-muted-foreground font-light">
                Invite Code
              </label>
              <input
                id="invite-code"
                type="text"
                value={inviteCode}
                onChange={(e) => {
                  setInviteCode(e.target.value.toUpperCase())
                  setJoinError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleJoinHouse()
                  } else if (e.key === 'Escape') {
                    setShowJoinDialog(false)
                    setInviteCode('')
                    setJoinError('')
                  }
                }}
                placeholder="ABC12345"
                maxLength={8}
                className="w-full px-4 py-2 bg-background border border-border rounded-md text-sm font-mono tracking-wider uppercase focus:outline-none focus:ring-2 focus:ring-primary"
                autoFocus
              />
              {joinError && (
                <p className="text-xs text-red-500">{joinError}</p>
              )}
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  setShowJoinDialog(false)
                  setInviteCode('')
                  setJoinError('')
                }}
                variant="outline"
                className="flex-1 h-10 font-light"
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleJoinHouse}
                className="flex-1 h-10 bg-foreground text-background hover:bg-foreground/90 font-light"
                disabled={isCreating || inviteCode.trim().length !== 8}
              >
                {isCreating ? 'Joining...' : 'Join'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default HouseListPage

