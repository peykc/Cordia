import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Settings, Volume2, Copy, Check, Mic, MicOff, PhoneOff, Plus } from 'lucide-react'
import { Button } from '../components/ui/button'
import { loadHouse, addRoom, type House, type Room, fetchAndImportHouseHintOpaque, publishHouseHintOpaque, createTemporaryInvite, revokeActiveInvite } from '../lib/tauri'
import { useIdentity } from '../contexts/IdentityContext'
import { useWebRTC } from '../contexts/WebRTCContext'
import { SignalingStatus } from '../components/SignalingStatus'
import { useSignaling } from '../contexts/SignalingContext'

function HouseViewPage() {
  const { houseId } = useParams<{ houseId: string }>()
  const navigate = useNavigate()
  const { identity } = useIdentity()
  const { joinVoice, leaveVoice, toggleMute: webrtcToggleMute, isLocalMuted, peers } = useWebRTC()
  const { signalingUrl, status: signalingStatus } = useSignaling()
  const [house, setHouse] = useState<House | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [copiedInvite, setCopiedInvite] = useState(false)
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null)
  const [isInVoice, setIsInVoice] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [showCreateRoomDialog, setShowCreateRoomDialog] = useState(false)
  const [roomName, setRoomName] = useState('')
  const [roomDescription, setRoomDescription] = useState('')
  const [isCreatingRoom, setIsCreatingRoom] = useState(false)
  const [isCreatingInvite, setIsCreatingInvite] = useState(false)
  const [isRevokingInvite, setIsRevokingInvite] = useState(false)

  useEffect(() => {
    if (!houseId) {
      navigate('/houses')
      return
    }

    loadHouseData()

    // Reload house data when window gains focus (e.g., alt-tabbing between instances)
    const handleFocus = () => {
      console.log('[HouseView] Window focused - reloading house data')
      loadHouseData()
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [houseId])

  const loadHouseData = async () => {
    if (!houseId) return

    try {
      // Load local first for fast UI
      let loadedHouse = await loadHouse(houseId)

      // If signaling is connected, pull latest hint to refresh metadata (members/rooms) across accounts.
      // This uses a merge-import on the backend that preserves local encrypted secrets.
      if (signalingStatus === 'connected' && signalingUrl) {
        try {
          const changed = await fetchAndImportHouseHintOpaque(signalingUrl, loadedHouse.signing_pubkey)
          if (changed) loadedHouse = await loadHouse(houseId)
        } catch (e) {
          console.warn('[HouseView] Failed to refresh house hint:', e)
        }
      }

      setHouse(loadedHouse)
    } catch (error) {
      console.error('Failed to load house:', error)
      navigate('/houses')
    } finally {
      setIsLoading(false)
    }
  }

  const copyInviteCode = () => {
    if (!house) return
    const code = getActiveInviteCode()
    if (!code) return
    // Copy just the code. Join UI will use the user's configured signaling server under the hood.
    navigator.clipboard.writeText(code)
    setCopiedInvite(true)
    setTimeout(() => setCopiedInvite(false), 2000)
  }

  const getActiveInviteUri = (): string | null => {
    if (!house) return null
    const uri = house.active_invite_uri || null
    const expiresAt = house.active_invite_expires_at ? new Date(house.active_invite_expires_at) : null
    if (!uri) return null
    // If expires_at isn't present (older data), treat it as active until revoked.
    if (expiresAt && Date.now() > expiresAt.getTime()) return null
    return uri
  }

  const getActiveInviteCode = (): string | null => {
    const uri = getActiveInviteUri()
    if (!uri) return null
    const parsed = uri.trim().match(/^rmmt:\/\/([^@]+)@/i)
    return parsed ? parsed[1] : null
  }

  const handleCreateInvite = async () => {
    if (!houseId || !house) return
    if (signalingStatus !== 'connected' || !signalingUrl) return

    setIsCreatingInvite(true)
    try {
      // Default: unlimited uses until someone revokes.
      await createTemporaryInvite(signalingUrl, houseId, 0)
      const updated = await loadHouse(houseId)
      setHouse(updated)
    } catch (e) {
      console.warn('Failed to create invite:', e)
    } finally {
      setIsCreatingInvite(false)
    }
  }

  const handleRevokeInvite = async () => {
    if (!houseId) return
    if (signalingStatus !== 'connected' || !signalingUrl) return
    setIsRevokingInvite(true)
    try {
      await revokeActiveInvite(signalingUrl, houseId)
      const updated = await loadHouse(houseId)
      setHouse(updated)
    } catch (e) {
      console.warn('Failed to revoke invite:', e)
    } finally {
      setIsRevokingInvite(false)
    }
  }

  // When house hints are imported via WS sync, refresh our local view.
  useEffect(() => {
    if (!houseId) return
    const onHousesUpdated = () => {
      loadHouse(houseId).then(setHouse).catch(() => {})
    }
    window.addEventListener('roommate:houses-updated', onHousesUpdated)
    return () => window.removeEventListener('roommate:houses-updated', onHousesUpdated)
  }, [houseId])

  const handleSelectRoom = (room: Room) => {
    if (currentRoom?.id === room.id) return
    setCurrentRoom(room)
    setIsInVoice(false)
    setIsMuted(false)
    console.log('Opened room:', room.name)
  }

  const handleJoinVoice = async () => {
    if (!currentRoom || !house || !identity) return

    try {
      await joinVoice(currentRoom.id, house.id, identity.user_id)
      setIsInVoice(true)
      setIsMuted(false)
      console.log('Joined voice in room:', currentRoom.name)
    } catch (error) {
      console.error('Failed to join voice:', error)
    }
  }

  const handleLeaveVoice = () => {
    if (!currentRoom) return

    leaveVoice()
    setIsInVoice(false)
    setIsMuted(false)
    console.log('Left voice in room:', currentRoom.name)
  }

  const toggleMute = () => {
    webrtcToggleMute()
    setIsMuted(isLocalMuted)
    console.log('Mute toggled:', isLocalMuted)
  }

  const handleCreateRoom = async () => {
    if (!houseId || !roomName.trim()) return

    setIsCreatingRoom(true)
    try {
      const updatedHouse = await addRoom(
        houseId,
        roomName.trim(),
        roomDescription.trim() || null
      )
      setHouse(updatedHouse)

      // Publish updated hint (rooms changed)
      if (signalingStatus === 'connected' && signalingUrl) {
        publishHouseHintOpaque(signalingUrl, updatedHouse.id).catch(e => console.warn('Failed to publish house hint:', e))
      }

      setShowCreateRoomDialog(false)
      setRoomName('')
      setRoomDescription('')
    } catch (error) {
      console.error('Failed to create room:', error)
    } finally {
      setIsCreatingRoom(false)
    }
  }

  if (isLoading) {
    return (
      <div className="h-full bg-background grid-pattern flex items-center justify-center">
        <p className="text-muted-foreground text-sm font-light">Loading house...</p>
      </div>
    )
  }

  if (!house) {
    return (
      <div className="h-full bg-background grid-pattern flex items-center justify-center">
        <p className="text-muted-foreground text-sm font-light">House not found</p>
      </div>
    )
  }

  return (
    <div className="h-full bg-background grid-pattern flex flex-col">
      <header className="border-b-2 border-border">
        <div className="container flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/houses')}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="w-px h-6 bg-foreground/20"></div>
            <h1 className="text-sm font-light tracking-wider uppercase">{house.name}</h1>
          </div>
          <div className="flex items-center gap-2">
            <SignalingStatus />
            <Link to="/settings">
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <Settings className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - Rooms List */}
        <div className="w-64 border-r-2 border-border bg-card/50 flex flex-col">
          <div className="p-4 flex flex-col h-full">
            <div className="space-y-2">
              <div className="flex items-center justify-between px-2">
                <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground">
                  Rooms
                </h2>
                <button
                  onClick={() => setShowCreateRoomDialog(true)}
                  className="p-1 rounded transition-colors hover:bg-accent/50 text-muted-foreground hover:text-foreground"
                  title="Create new room"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
              <div className="space-y-1">
                {house.rooms.map((room) => (
                  <button
                    key={room.id}
                    onClick={() => handleSelectRoom(room)}
                    className={`w-full px-3 py-2 rounded-md transition-colors text-left group ${
                      currentRoom?.id === room.id
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-accent/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">#</span>
                        <span className="text-sm font-light">{room.name}</span>
                      </div>
                      {currentRoom?.id === room.id && isInVoice && (
                        <Volume2 className="h-3 w-3" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-auto pt-4 border-t border-border">
              {!getActiveInviteUri() ? (
                <Button
                  onClick={handleCreateInvite}
                  size="sm"
                  className="h-9 font-light w-full"
                  disabled={isCreatingInvite || signalingStatus !== 'connected' || !signalingUrl}
                >
                  {isCreatingInvite ? 'Creating…' : 'Create invite'}
                </Button>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 px-3 py-2 bg-background border border-border rounded-md">
                      <code className="text-xs font-mono break-all">{getActiveInviteCode() || ''}</code>
                    </div>
                    <Button
                      onClick={copyInviteCode}
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                    >
                      {copiedInvite ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <button
                    onClick={handleRevokeInvite}
                    className="text-xs text-red-500 underline underline-offset-4 hover:text-red-400 transition-colors"
                    type="button"
                    disabled={isRevokingInvite || signalingStatus !== 'connected' || !signalingUrl}
                  >
                    {isRevokingInvite ? 'Revoking…' : 'Revoke access'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main Content - Text Chat + Optional Voice */}
        <div className="flex-1 flex flex-col">
          {!currentRoom ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-md w-full space-y-6 text-center">
                <div className="w-12 h-px bg-foreground/20 mx-auto"></div>
                <h2 className="text-xl font-light tracking-tight">Select a room</h2>
                <p className="text-muted-foreground text-sm leading-relaxed font-light">
                  Choose a room from the sidebar to start chatting with your roommates.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Room Header */}
              <div className="border-b-2 border-border p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl font-light">#</span>
                    <div className="space-y-1">
                      <h2 className="text-lg font-light tracking-tight">{currentRoom.name}</h2>
                      {currentRoom.description && (
                        <p className="text-xs text-muted-foreground">{currentRoom.description}</p>
                      )}
                    </div>
                  </div>
                  {!isInVoice ? (
                    <Button
                      onClick={handleJoinVoice}
                      variant="default"
                      size="sm"
                      className="h-9 gap-2"
                    >
                      <Volume2 className="h-4 w-4" />
                      Join Voice
                    </Button>
                  ) : (
                    <Button
                      onClick={handleLeaveVoice}
                      variant="destructive"
                      size="sm"
                      className="h-9 gap-2"
                    >
                      <PhoneOff className="h-4 w-4" />
                      Leave Voice
                    </Button>
                  )}
                </div>
              </div>

              {/* Voice Panel (shown when in voice) */}
              {isInVoice && (
                <div className="border-b-2 border-border bg-accent/30 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                          <span className="text-sm font-light">
                            {identity?.display_name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-light">{identity?.display_name}</p>
                          <div className="flex items-center gap-1">
                            {isMuted ? (
                              <MicOff className="h-3 w-3 text-red-500" />
                            ) : (
                              <Mic className="h-3 w-3 text-green-500" />
                            )}
                            <span className="text-xs text-muted-foreground">
                              {isMuted ? 'Muted' : 'Connected'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <Button
                      onClick={toggleMute}
                      variant={isMuted ? 'destructive' : 'outline'}
                      size="sm"
                      className="h-9 w-9"
                    >
                      {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    </Button>
                  </div>

                  {/* Remote Peers */}
                  {peers.size > 0 && (
                    <div className="mt-4 pt-4 border-t-2 border-border space-y-2">
                      <p className="text-xs text-muted-foreground font-light uppercase tracking-wide mb-2">
                        Connected Peers ({peers.size})
                      </p>
                      {Array.from(peers.entries()).map(([peerId, info]) => {
                        // Find peer display name from house members
                        const peerMember = house?.members.find(m => m.user_id === peerId)
                        const displayName = peerMember?.display_name || peerId.substring(0, 8)

                        return (
                          <div key={peerId} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                                <span className="text-xs font-light">
                                  {displayName.charAt(0).toUpperCase()}
                                </span>
                              </div>
                              <div>
                                <p className="text-sm font-light">{displayName}</p>
                                <span className="text-xs text-muted-foreground">
                                  {info.connectionState === 'connected' ? 'Connected' : 'Connecting...'}
                                </span>
                              </div>
                            </div>
                            <div className={`w-2 h-2 rounded-full ${
                              info.connectionState === 'connected' ? 'bg-green-500' :
                              info.connectionState === 'connecting' ? 'bg-yellow-500 animate-pulse' :
                              'bg-red-500'
                            }`} />
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Text Chat Area */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="max-w-4xl mx-auto space-y-4">
                    {/* Welcome Message */}
                    <div className="p-4 border-2 border-border rounded-lg bg-card/50">
                      <p className="text-sm text-muted-foreground font-light">
                        Welcome to <span className="text-foreground font-normal">#{currentRoom.name}</span>
                        {currentRoom.description && ` — ${currentRoom.description}`}
                      </p>
                    </div>
                    {/* TODO: Actual messages will go here */}
                  </div>
                </div>

                {/* Message Input */}
                <div className="border-t-2 border-border p-4 bg-card/50">
                  <div className="max-w-4xl mx-auto">
                    <input
                      type="text"
                      placeholder={`Message #${currentRoom.name}`}
                      className="w-full px-4 py-3 bg-background border border-border rounded-lg text-sm font-light focus:outline-none focus:ring-2 focus:ring-primary"
                      disabled
                    />
                    <p className="text-xs text-muted-foreground mt-2">
                      Text chat coming soon. Voice chat is the priority!
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right Sidebar - Members List */}
        <div className="w-64 border-l-2 border-border bg-card/50">
          <div className="p-4 space-y-2">
            <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground px-2">
              Members — {house.members.length}
            </h2>
            <div className="space-y-1">
              {house.members.map((member) => (
                <div
                  key={member.user_id}
                  className="px-3 py-2 rounded-md hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                      <span className="text-xs font-light">
                        {member.display_name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span className="text-sm font-light truncate">{member.display_name}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Create Room Dialog */}
      {showCreateRoomDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border-2 border-border rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-lg font-light mb-4">Create New Room</h2>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-light block mb-2">Room Name</label>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm"
                  placeholder="general, voice-chat, etc."
                  autoFocus
                />
              </div>

              <div>
                <label className="text-sm font-light block mb-2">Description (optional)</label>
                <input
                  type="text"
                  value={roomDescription}
                  onChange={(e) => setRoomDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm"
                  placeholder="What's this room for?"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <Button
                onClick={() => {
                  setShowCreateRoomDialog(false)
                  setRoomName('')
                  setRoomDescription('')
                }}
                variant="outline"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateRoom}
                disabled={!roomName.trim() || isCreatingRoom}
                className="flex-1"
              >
                {isCreatingRoom ? 'Creating...' : 'Create Room'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default HouseViewPage
