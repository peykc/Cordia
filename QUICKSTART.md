# Roommate Quick Start Guide

Get up and running with Roommate in 3 easy steps.

## Prerequisites

Before you begin, make sure you have:

- ✅ **Node.js** (v18 or higher) - [Download](https://nodejs.org/)
- ✅ **Rust** (latest stable) - [Install Rust](https://www.rust-lang.org/tools/install)
- ✅ **Docker Desktop** (optional - only if you want to self-host your own signaling server) - [Download Docker](https://docs.docker.com/desktop/)

**Note:** Roommate includes a default signaling server at `signal.pkcollection.net` that works immediately - no Docker needed!

## Step 1: Signaling Server Setup

Roommate comes with a **default signaling server** at `signal.pkcollection.net` that works out of the box! No setup required.

**Option A: Use Default Server (Easiest - Recommended)**
- ✅ No configuration needed
- ✅ Works immediately
- ✅ Full features available
- ✅ **Privacy:** The server cannot read your data - all house data is encrypted and stored locally
- The app automatically connects to `signal.pkcollection.net`

**Option B: Self-Host Your Own Server (Optional)**
If you prefer to run your own signaling server:

```bash
docker-compose up -d
```

**Verify it's running:**
```bash
docker-compose logs signaling-server
```

You should see: `Signaling server listening on ws://127.0.0.1:9001`

**Note:** You can change the signaling server URL at any time in Settings → Connections. Each account can use a different server.

**Privacy Note:** The signaling server cannot read your user data. All house data, room content, and messages are encrypted and stored locally. The server only helps with peer discovery and presence tracking. Your voice communication is direct peer-to-peer and never passes through the server.

## Step 2: Install Dependencies and Start Roommate

```bash
# Install dependencies (first time only)
npm install

# Start the app
npm run tauri dev
```

The app window will open automatically.

## Step 3: Create Your First House

1. **Create Your Identity** (first time only):
   - Enter a display name (e.g., "Alice")
   - Click "Create Identity"
   - ⚠️ **Important:** Save your recovery key somewhere safe! You'll need it to restore your account.

2. **Create a House**:
   - Click the **"New House"** button
   - Enter a name (e.g., "My Friends")
   - Click "Create"

3. **Check Connection Status**:
   - Look at the top bar
   - Should show 🟢 **"Connected"** status
   - This means the signaling server is working and full features are available
   - By default, it connects to `signal.pkcollection.net`
   - You can change this in Settings → Connections at any time

4. **Create a Room** (optional):
   - Click the **+** button next to "Rooms" in the sidebar
   - Enter room name (e.g., "Gaming", "General")
   - Click "Create Room"

5. **Join Voice Chat**:
   - Click on a room name
   - Hover over the room name to see the phone icon, or click into the room
   - Click the phone icon to join voice
   - Start talking! 🎤

## Inviting Friends

1. **Get the Invite Code**:
   - Open your house
   - Look in the right sidebar under "House Invite"
   - Click "Copy" to copy the invite code

2. **Share the Code**:
   - Send the code to your friend (via text, email, etc.)

3. **Friend Joins**:
   - Your friend opens Roommate
   - Clicks "Join House"
   - Pastes the invite code
   - They'll appear in your house automatically!

## Troubleshooting

### ❌ Red "Offline" or "Disconnected" indicator?

**Problem:** Can't connect to the signaling server.

**If using default server (`signal.pkcollection.net`):**
- Check your internet connection
- The default server may be temporarily unavailable
- Try switching to a self-hosted server (see [SIGNALING_SETUP.md](SIGNALING_SETUP.md))

**If using self-hosted server:**
```bash
# Check if signaling server is running
docker-compose ps

# If not running, start it
docker-compose up -d

# Check logs for errors
docker-compose logs signaling-server

# Restart the Roommate app
# Close the app window and run: npm run tauri dev
```

**Change Server URL:**
- Go to Settings → Connections
- Update the signaling server URL
- You can switch between the default server (`signal.pkcollection.net`) and your own at any time

### ❌ Can't create rooms?

**Problem:** Room creation requires the signaling server to be connected.

**Solution:**
- Check the connection status in the top bar
- If using default server (`signal.pkcollection.net`), check your internet connection
- If using self-hosted server and it shows red/offline, start it: `docker-compose up -d`
- You can change servers in Settings → Connections at any time
- Restart the Roommate app if needed

### ❌ Docker not installed or not running?

**Problem:** Docker Desktop isn't installed or isn't running.

**Solution:**
1. [Install Docker Desktop](https://docs.docker.com/desktop/)
2. Make sure Docker Desktop is running (check system tray)
3. Try again: `docker-compose up -d`

### ❌ "Audio meter stream is not live" error?

**Problem:** Audio device issue when rejoining a call.

**Solution:**
- Change your input audio device in Settings → Audio
- Or restart the app

### ❌ Can't hear others or they can't hear you?

**Problem:** Audio settings or device permissions.

**Solution:**
1. Go to Settings → Audio
2. Check your input/output device selection
3. Test your microphone threshold
4. Make sure your system has granted microphone permissions to the app

### ❌ Build errors on Windows?

**Problem:** Missing Visual C++ Build Tools.

**Solution:**
See **[SETUP.md](SETUP.md)** for Windows-specific setup instructions.

## Daily Usage

**Starting everything:**
```bash
# Terminal 1: Start signaling server (or run in background with -d)
docker-compose up -d

# Terminal 2: Start Roommate app
npm run tauri dev
```

**Stopping the signaling server:**
```bash
docker-compose down
```

**Note:** You can keep the signaling server running in the background. It will automatically restart if your computer reboots (if Docker is set to start on boot).

## What's Next?

- 🎛️ **Configure Audio Settings** - Go to Settings → Audio to adjust voice activation threshold, push-to-talk, and device selection
- 👥 **Invite Friends** - Share your house invite code to get friends connected
- 🏠 **Create Multiple Houses** - Organize different groups (work, friends, family)
- 🗣️ **Try Voice Features** - Test voice activity detection, presence indicators, and call management
- 📦 **Backup Your Account** - Export your identity in Settings → Info & Export to backup your keys

## Need More Help?

- **Detailed Setup:** See [SETUP.md](SETUP.md) for platform-specific instructions
- **Signaling Server:** See [SIGNALING_SETUP.md](SIGNALING_SETUP.md) for advanced configuration
- **Deployment:** See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) to deploy your own signaling server
