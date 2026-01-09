import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Settings, Volume2, Copy, Check, Mic, MicOff, PhoneOff, Plus } from 'lucide-react'
import { Button } from '../components/ui/button'
import { loadHouse, addRoom, type House, type Room } from '../lib/tauri'
import { useIdentity } from '../contexts/IdentityContext'
import { useSignaling } from '../contexts/SignalingContext'
import { SignalingStatus } from '../components/SignalingStatus'

function HouseViewPage() {
  const { houseId } = useParams<{ houseId: string }>()
  const navigate = useNavigate()
  const { identity } = useIdentity()
  const { status: signalingStatus } = useSignaling()
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

  useEffect(() => {
    if (!houseId) {
      navigate('/houses')
      return
    }

    loadHouseData()
  }, [houseId])

  const loadHouseData = async () => {
    if (!houseId) return

    try {
      const loadedHouse = await loadHouse(houseId)
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
    navigator.clipboard.writeText(house.invite_code)
    setCopiedInvite(true)
    setTimeout(() => setCopiedInvite(false), 2000)
  }

  const handleSelectRoom = (room: Room) => {
    if (currentRoom?.id === room.id) return
    setCurrentRoom(room)
    setIsInVoice(false)
    setIsMuted(false)
    console.log('Opened room:', room.name)
  }

  const handleJoinVoice = () => {
    if (!currentRoom) return
    setIsInVoice(true)
    setIsMuted(false)
    // TODO: Initialize WebRTC connection
    console.log('Joining voice in room:', currentRoom.name)
  }

  const handleLeaveVoice = () => {
    if (!currentRoom) return
    // TODO: Close WebRTC connection
    console.log('Leaving voice in room:', currentRoom.name)
    setIsInVoice(false)
    setIsMuted(false)
  }

  const toggleMute = () => {
    setIsMuted(!isMuted)
    // TODO: Mute/unmute audio stream
    console.log('Mute toggled:', !isMuted)
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
          <div className="p-4 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between px-2">
                <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground">
                  Rooms
                </h2>
                <button
                  onClick={() => setShowCreateRoomDialog(true)}
                  disabled={signalingStatus !== 'connected'}
                  className={`p-1 rounded transition-colors ${
                    signalingStatus === 'connected'
                      ? 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
                      : 'text-muted-foreground/30 cursor-not-allowed'
                  }`}
                  title={
                    signalingStatus === 'connected'
                      ? 'Create new room'
                      : 'Signaling server required for room creation'
                  }
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

            <div className="pt-4 border-t border-border space-y-2">
              <h3 className="text-xs font-light tracking-wider uppercase text-muted-foreground px-2">
                Invite Code
              </h3>
              <div className="flex items-center gap-2">
                <div className="flex-1 px-3 py-2 bg-background border border-border rounded-md">
                  <code className="text-sm font-mono tracking-wider">{house.invite_code}</code>
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
              <p className="text-xs text-muted-foreground px-2 leading-relaxed">
                Share this code with friends to invite them to this house.
              </p>
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
    </div>
  )
}

export default HouseViewPage
