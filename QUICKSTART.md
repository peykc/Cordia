# Roommate Quick Start Guide

Get up and running with Roommate in 3 easy steps.

## Step 1: Start the Signaling Server

```bash
docker-compose up -d
```

**Expected output:**
```
Creating network "roommate_default" with the default driver
Building signaling-server
...
Creating roommate-signaling ... done
```

**Note:** The server will store data in `/mnt/App/apps/signal` with proper permissions (PUID=1000, PGID=1000).

**Verify it's running:**
```bash
docker-compose logs signaling-server
```

You should see: `Signaling server listening on ws://127.0.0.1:9001`

## Step 2: Start Roommate

```bash
npm run tauri dev
```

The app will open automatically.

## Step 3: Create Your First House

1. **Create Identity** (first time only):
   - Enter a display name
   - Click "Create Identity"
   - Save your recovery key somewhere safe

2. **Create a House**:
   - Click "Create House"
   - Enter a name (e.g., "My Friends")
   - Click "Create"

3. **Check Connection Status**:
   - Look at the top-right corner
   - Should show 🟢 **"Connected"**
   - Hover to see: "Connected to ws://127.0.0.1:9001. Full features available including room creation."

4. **Create a Room** (optional):
   - Click the **+** button next to "Rooms"
   - Enter room name (e.g., "Gaming")
   - Click "Create Room"

5. **Join Voice**:
   - Click on a room (like "General")
   - Click the "Join Voice" button
   - Start talking!

## Inviting Friends

1. Copy the invite code from the sidebar
2. Send it to your friend
3. They click "Join House" and paste the code
4. They'll appear in the house automatically

## Troubleshooting

### Red "Offline" indicator?

**Fix:**
```bash
# Check if signaling server is running
docker-compose ps

# If not running, start it
docker-compose up -d

# Restart the app
# Close Roommate and run: npm run tauri dev
```

### Can't create rooms?

- Room creation requires the signaling server to be connected (green indicator)
- If offline (red indicator), you'll only have the default "General" room
- Start the signaling server with `docker-compose up -d`

### Docker not installed?

[Install Docker Desktop](https://docs.docker.com/desktop/) then run:
```bash
docker-compose up -d
```

## Daily Usage

**Start everything:**
```bash
# Terminal 1 (or run in background with -d)
docker-compose up -d

# Terminal 2
npm run tauri dev
```

**Stop signaling server:**
```bash
docker-compose down
```

## What's Next?

- Configure audio settings in Settings → Audio
- Try Push-to-Talk mode
- Create multiple rooms for different topics
- Invite friends with the invite code

For detailed setup and troubleshooting, see `SIGNALING_SETUP.md`.
