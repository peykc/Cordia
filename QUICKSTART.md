# Cordia Quick Start Guide

Get up and running with Cordia in 3 easy steps.

## Prerequisites

Before you begin, make sure you have:

- ✅ **Node.js** (v18 or higher) - [Download](https://nodejs.org/)
- ✅ **Rust** (latest stable) - [Install Rust](https://www.rust-lang.org/tools/install)
- ✅ **Docker Desktop** (optional - only if you want to self-host your own beacon) - [Download Docker](https://docs.docker.com/desktop/)

**Note:** Cordia includes a default beacon at `beacon.pkcollection.net` that works immediately - no Docker needed!

## Step 1: Beacon Setup

Cordia comes with a **default beacon** at `beacon.pkcollection.net` that works out of the box! No setup required.

**Option A: Use Default Beacon (Easiest - Recommended)**
- ✅ No configuration needed
- ✅ Works immediately
- ✅ Full features available
- ✅ **Privacy:** The beacon cannot read your data - all server data is encrypted and stored locally
- The app automatically connects to `beacon.pkcollection.net`

**Option B: Self-Host Your Own Beacon (Optional)**
If you prefer to run your own beacon:

```bash
docker-compose up -d
```

**Verify it's running:**
```bash
docker-compose logs cordia-beacon
```

You should see: `Beacon listening on ws://127.0.0.1:9001`

**Note:** You can change the beacon URL at any time in Settings → Connections. Each account can use a different beacon.

**Privacy Note:** The beacon cannot read your user data. All server data, chat content, and messages are encrypted and stored locally. The beacon only helps with peer discovery and presence tracking. Your voice communication is direct peer-to-peer and never passes through the beacon.

## Step 2: Install Dependencies and Start Cordia

```bash
# Install dependencies (first time only)
npm install

# Start the app
npm run tauri dev
```

The app window will open automatically.

## Step 3: Create Your First Server

1. **Create Your Identity** (first time only):
   - Enter a display name (e.g., "Alice")
   - Click "Create Identity"
   - ⚠️ **Important:** Save your recovery key somewhere safe! You'll need it to restore your account.

2. **Create a Server**:
   - Click the **"New Server"** button
   - Enter a name (e.g., "My Friends")
   - Click "Create"

3. **Check Connection Status**:
   - Look at the top bar
   - Should show 🟢 **"Connected"** status
   - This means the beacon is working and full features are available
   - By default, it connects to `beacon.pkcollection.net`
   - You can change this in Settings → Connections at any time

4. **Create a Chat** (optional):
   - Click the **+** button next to "Chats" in the sidebar
   - Enter chat name (e.g., "Gaming", "General")
   - Click "Create Chat"

5. **Join Voice Chat**:
   - Click on a chat name
   - Hover over the chat name to see the phone icon, or click into the chat
   - Click the phone icon to join voice
   - Start talking! 🎤

## Inviting Friends

1. **Get the Invite Code**:
   - Open your server
   - Look in the right sidebar under "Invite"
   - Click "Copy" to copy the invite code

2. **Share the Code**:
   - Send the code to your friend (via text, email, etc.)

3. **Friend Joins**:
   - Your friend opens Cordia
   - Clicks "Join Server"
   - Pastes the invite code
   - They'll appear in your server automatically!

## Troubleshooting

### ❌ Red "Offline" or "Disconnected" indicator?

**Problem:** Can't connect to the beacon.

**If using default beacon (`beacon.pkcollection.net`):**
- Check your internet connection
- The default beacon may be temporarily unavailable
- Try switching to a self-hosted beacon (see [SIGNALING_SETUP.md](SIGNALING_SETUP.md))

**If using self-hosted beacon:**
```bash
# Check if beacon is running
docker-compose ps

# If not running, start it
docker-compose up -d

# Check logs for errors
docker-compose logs cordia-beacon

# Restart the Cordia app
# Close the app window and run: npm run tauri dev
```

**Change Beacon URL:**
- Go to Settings → Connections
- Update the beacon URL
- You can switch between the default beacon (`beacon.pkcollection.net`) and your own at any time

### ❌ Can't create chats?

**Problem:** Chat creation requires the beacon to be connected.

**Solution:**
- Check the connection status in the top bar
- If using default beacon (`beacon.pkcollection.net`), check your internet connection
- If using self-hosted beacon and it shows red/offline, start it: `docker-compose up -d`
- You can change beacons in Settings → Connections at any time
- Restart the Cordia app if needed

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
# Terminal 1: Start beacon (or run in background with -d)
docker-compose up -d

# Terminal 2: Start Cordia app
npm run tauri dev
```

**Stopping the beacon:**
```bash
docker-compose down
```

**Note:** You can keep the beacon running in the background. It will automatically restart if your computer reboots (if Docker is set to start on boot).

## What's Next?

- 🎛️ **Configure Audio Settings** - Go to Settings → Audio to adjust voice activation threshold, push-to-talk, and device selection
- 👥 **Invite Friends** - Share your server invite code to get friends connected
- 🏠 **Create Multiple Servers** - Organize different groups (work, friends, family)
- 🗣️ **Try Voice Features** - Test voice activity detection, presence indicators, and call management
- 📦 **Backup Your Account** - Export your identity in Settings → Info & Export to backup your keys

## Need More Help?

- **Detailed Setup:** See [SETUP.md](SETUP.md) for platform-specific instructions
- **Beacon Setup:** See [SIGNALING_SETUP.md](SIGNALING_SETUP.md) for advanced configuration
- **Deployment:** See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) to deploy your own beacon
