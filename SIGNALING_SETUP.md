# Roommate Signaling Server Setup Guide

This guide will help you get the Roommate signaling server up and running.

## Prerequisites

- **Docker** and **Docker Compose**
  - Windows: [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
  - Mac: [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
  - Linux: [Docker Engine](https://docs.docker.com/engine/install/)

## Quick Start (Recommended)

### 1. Start the Signaling Server with Docker

```bash
# From the project root directory
docker-compose up -d
```

This will:
- Build the signaling server Docker image
- Start the server on `ws://localhost:9001`
- Run it in the background with automatic restart

**Verify it's running:**
```bash
docker-compose ps
```

You should see `roommate-signaling` with status "Up".

**View logs:**
```bash
docker-compose logs -f signaling-server
```

### 2. Start the Roommate Application

```bash
# Install dependencies (first time only)
npm install

# Start the development server
npm run tauri dev
```

The app will launch and automatically detect the signaling server.

## Connection Status

Look for the connection indicator in the top-right corner of the house view:

- **🟢 Green "Connected"**: Signaling server is online - full features available
- **🟡 Yellow "Checking"**: Checking connection status
- **🔴 Red "Offline"**: Signaling server offline - limited to single room per house

Hover over the indicator to see more details.

## Alternative: Running Without Docker (Development)

If you prefer to run the signaling server directly with Rust:

```bash
# Terminal 1 - Signaling Server
cd signaling-server
RUST_LOG=info cargo run

# Terminal 2 - Roommate App (from project root)
npm run tauri dev
```

## Managing the Signaling Server

### Stop the server
```bash
docker-compose down
```

### Restart the server
```bash
docker-compose restart signaling-server
```

### Rebuild after code changes
```bash
docker-compose up -d --build
```

### View real-time logs
```bash
docker-compose logs -f signaling-server
```

### Check server health
```bash
docker-compose exec signaling-server echo "Server is running"
```

## Configuration

### Storage Location
The signaling server stores logs and configuration in `/mnt/App/apps/signal` on the host machine.

This matches your Docker setup style and keeps all app data organized in one location.

### User Permissions
The container runs with PUID=1000 and PGID=1000 by default, ensuring files are owned by your user.

To use different user/group IDs, edit `docker-compose.yml`:
```yaml
environment:
  - PUID=YOUR_UID
  - PGID=YOUR_GID
```

### Timezone
Set to `America/New_York` by default. Change in `docker-compose.yml` if needed:
```yaml
environment:
  - TZ=Your/Timezone
```

### Default Signaling Server URL
The app defaults to `ws://127.0.0.1:9001`.

### Optional Postgres Durability (Profiles + Invites + House Hints + Events)
Postgres is **compile-time optional** and **runtime optional**. When enabled it persists
the event queue and acknowledgements for reliable offline catch-up.

- Build with `--features postgres` (or `SIGNALING_FEATURES=postgres` in Docker)
- Set `SIGNALING_DB_URL` at runtime

**Local dev (Rust):**
```bash
SIGNALING_DB_URL=postgres://user:pass@localhost:5432/roommate \
cargo run --features postgres
```

**Docker (build with features):**
```bash
SIGNALING_FEATURES=postgres docker-compose up -d --build
```

Then set the runtime env var in `docker-compose.yml`:
```yaml
environment:
  - SIGNALING_DB_URL=postgres://user:pass@db:5432/roommate
```

**Note:** the prebuilt image in `deploy/docker-compose.yml` does not include optional features.

### Optional Redis Presence Backend
Redis is **compile-time optional** and **runtime optional**. It stores ephemeral presence
state with a TTL and falls back to in-memory if Redis is unavailable.

- Build with `--features redis-backend` (or `SIGNALING_FEATURES=redis-backend` in Docker)
- Set `SIGNALING_REDIS_URL` at runtime

**Local dev (Rust):**
```bash
SIGNALING_REDIS_URL=redis://localhost:6379 \
cargo run --features redis-backend
```

**Docker (build with features):**
```bash
SIGNALING_FEATURES=redis-backend docker-compose up -d --build
```

Optional TTL override (default: 120 seconds):
```bash
SIGNALING_REDIS_PRESENCE_TTL_SECS=120
```

### Changing the Port

**Option 1: Using Docker (recommended)**

Edit `docker-compose.yml`:
```yaml
ports:
  - "YOUR_PORT:9001"  # Change left side only
```

Then update the default URL in the app:
- Edit `src-tauri/src/signaling.rs`
- Change `"ws://127.0.0.1:9001"` to `"ws://127.0.0.1:YOUR_PORT"`

**Option 2: Running directly**

Edit `signaling-server/src/main.rs`:
```rust
let addr = "127.0.0.1:YOUR_PORT";  // Change port here
```

Then update the app's default URL as above.

## Troubleshooting

### Issue: Port 9001 Already in Use

**Windows:**
```powershell
# Find process using port 9001
netstat -ano | findstr :9001

# Kill the process (replace PID with actual process ID)
taskkill /F /PID <PID>
```

**Mac/Linux:**
```bash
# Find and kill process on port 9001
lsof -ti:9001 | xargs kill -9
```

### Issue: Docker Not Running

- Make sure Docker Desktop is running
- Try `docker ps` to verify Docker is accessible
- Restart Docker Desktop if needed

### Issue: App Shows "Offline" Status

1. **Verify signaling server is running:**
   ```bash
   docker-compose ps
   ```
   Should show `roommate-signaling` as "Up"

2. **Check server logs:**
   ```bash
   docker-compose logs signaling-server
   ```
   Look for "Signaling server listening on ws://127.0.0.1:9001"

3. **Test server manually:**
   - Open browser to `http://localhost:9001`
   - You should see a connection error (this is normal - it's a WebSocket-only server)
   - If you get "This site can't be reached", the server isn't running

4. **Restart the app:**
   - Close Roommate completely
   - Restart with `npm run tauri dev`
   - Check the connection indicator after app loads

### Issue: Docker Build Fails

```bash
# Clean up and rebuild
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Issue: Can't Connect from Another Device

The default configuration only allows connections from localhost (127.0.0.1).

To allow LAN connections:

1. Edit `signaling-server/src/main.rs`:
   ```rust
   let addr = "0.0.0.0:9001";  // Listen on all interfaces
   ```

2. Rebuild and restart:
   ```bash
   docker-compose up -d --build
   ```

3. Update Roommate app to use your machine's LAN IP:
   - Find your local IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
   - Update `src-tauri/src/signaling.rs` with `ws://YOUR_LAN_IP:9001`

## Features Based on Connection Mode

### ✅ With Signaling Server (Green - Connected)
- Create multiple rooms per house
- Room persistence
- Peer discovery
- Full P2P voice chat
- Automatic presence tracking

### ⚠️ Without Signaling Server (Red - Offline Mode)
- **Limited**: Single default room per house only
- Room creation button is disabled
- Can still do direct P2P connections (LAN/manual)
- Voice chat works with direct connections only

## Production Deployment

For deploying to a public server:

### 1. Deploy Docker Container to VPS

```bash
# On your VPS (DigitalOcean, AWS, etc.)
git clone <your-repo>
cd roommate
docker-compose up -d
```

### 2. Use a Domain Name

Add a reverse proxy (nginx) with SSL:

```nginx
server {
    listen 443 ssl;
    server_name signal.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:9001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 3. Update App Default URL

Edit `src-tauri/src/signaling.rs`:
```rust
pub fn get_default_signaling_url() -> String {
    "wss://signal.yourdomain.com".to_string()
}
```

Rebuild and distribute your app.

### 4. Security Considerations

- Add rate limiting (nginx or application level)
- Monitor for abuse
- Consider authentication for production
- Set up firewall rules
- Enable logging and monitoring

## Testing the Setup

1. **Start signaling server:**
   ```bash
   docker-compose up -d
   ```

2. **Verify it's running:**
   ```bash
   docker-compose logs signaling-server
   ```
   Should see: "Signaling server listening on ws://127.0.0.1:9001"

3. **Start Roommate app:**
   ```bash
   npm run tauri dev
   ```

4. **Check status:**
   - Create or open a house
   - Look at top-right corner for connection indicator
   - Should show green "Connected"
   - Hover to see tooltip: "Connected to ws://127.0.0.1:9001..."

5. **Test room creation:**
   - Click the "+" button next to "Rooms" in sidebar
   - If signaling is connected, dialog should open
   - If offline, button should be grayed out with tooltip

## Getting Help

**Check logs:**
```bash
docker-compose logs -f signaling-server
```

**Restart everything:**
```bash
docker-compose restart
npm run tauri dev
```

**Clean slate:**
```bash
docker-compose down
docker-compose up -d --build
```

If you continue to have issues, check:
1. Docker is running (`docker ps`)
2. Port 9001 is not in use by another process
3. Firewall isn't blocking local connections
4. App's signaling URL matches server URL
