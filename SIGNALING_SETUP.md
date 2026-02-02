# Beacon Setup Guide

This guide will help you set up your own beacon. **Note:** Cordia comes with a default beacon at `beacon.pkcollection.net` that you can use immediately - no setup required!

You only need to follow this guide if you want to:
- Self-host your own beacon
- Run a local development server
- Have full control over your beacon infrastructure

## Default Beacon

Cordia includes a default beacon at **`beacon.pkcollection.net`** that works out of the box. You can:
- Use it immediately with no configuration
- Change it at any time in Settings → Connections
- Use different beacons for different accounts
- Visit **https://beacon.pkcollection.net** (or your beacon’s URL) in a browser to see a **live count of concurrent connections** (updates every few seconds)

## Privacy & Security

**Important:** The beacon cannot read your user data. All server data, chat content, and messages are encrypted and stored locally on your device. The beacon only facilitates:
- Peer discovery (finding other users)
- Chat metadata (chat names, member lists)
- Presence tracking (who's online/active)

Your actual voice communication is direct peer-to-peer (WebRTC) and never passes through the beacon. Your server keys, encrypted data, and identity are stored locally and never sent to the beacon.

## Prerequisites

- **Docker** and **Docker Compose**
  - Windows: [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
  - macOS: [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
  - Linux: [Docker Engine](https://docs.docker.com/engine/install/)

## Quick Start

### Start the Beacon

```bash
# From the project root directory
docker-compose up -d
```

This will:
- Build the beacon Docker image
- Start the beacon on `ws://localhost:9001`
- Run it in the background with automatic restart

**Verify it's running:**
```bash
docker-compose ps
```

You should see `cordia-beacon` with status "Up".

**View logs:**
```bash
docker-compose logs -f cordia-beacon
```

You should see: `Beacon listening on ws://127.0.0.1:9001`

## Connection Status in App

Once the app is running, check the connection status:

- **🟢 Green "Connected"**: Beacon is online - full features available
- **🟡 Yellow "Checking"**: Checking connection status
- **🔴 Red "Offline"**: Beacon offline - limited to single chat per server

**Default Beacon:** The app connects to `beacon.pkcollection.net` by default. You can change this in Settings → Connections at any time. Each account can use a different beacon.

## Managing the Beacon

### Stop the beacon
```bash
docker-compose down
```

### Restart the beacon
```bash
docker-compose restart cordia-beacon
```

### Rebuild after code changes
```bash
docker-compose up -d --build
```

### View real-time logs
```bash
docker-compose logs -f cordia-beacon
```

## Alternative: Run Without Docker (Development)

If you prefer to run the beacon directly with Rust:

```bash
# Terminal 1 - Beacon
cd signaling-server
RUST_LOG=info cargo run

# Terminal 2 - Cordia App (from project root)
npm run tauri dev
```

## Configuration

### Default Port

The server runs on port `9001` by default. To change it:

1. Edit `docker-compose.yml`:
   ```yaml
   ports:
     - "YOUR_PORT:9001"  # Change left side only
   ```

2. Update the app's default URL in `src-tauri/src/signaling.rs`:
   ```rust
   pub fn get_default_signaling_url() -> String {
       "ws://127.0.0.1:YOUR_PORT".to_string()
   }
   ```

3. Restart:
   ```bash
   docker-compose up -d --build
   ```

### Storage Location

The beacon stores data in `/mnt/App/apps/signal` on the host machine (for production deployments). For local development, data is stored in Docker volumes.

### User Permissions

The container runs with PUID=1000 and PGID=1000 by default. To change:

```yaml
environment:
  - PUID=YOUR_UID
  - PGID=YOUR_GID
```

### Timezone

Set to `America/New_York` by default. Change in `docker-compose.yml`:

```yaml
environment:
  - TZ=Your/Timezone
```

### Security (beacon)

When the beacon is reachable from the internet (e.g. behind Cloudflare Zero Trust), you can tighten it with env vars. All are optional; defaults are permissive so existing setups keep working.

| Env var | Default | Description |
|--------|---------|-------------|
| `BEACON_CORS_ORIGINS` | (all) | Comma-separated allowed CORS origins, e.g. `https://app.example.com,https://cordia.example.com`. Unset or `*` = allow all. |
| `BEACON_MAX_BODY_BYTES` | 1000000 | Max request body size in bytes for REST (1 MiB). |
| `BEACON_MAX_WS_CONNECTIONS` | 0 (unlimited) | Max total WebSocket connections. |
| `BEACON_MAX_WS_PER_IP` | 0 (unlimited) | Max WebSocket connections per client IP. |

Client IP is taken from **CF-Connecting-IP** (Cloudflare) or **X-Forwarded-For** when behind a proxy; otherwise the direct peer is used. The beacon also sets **X-Content-Type-Options: nosniff** and **X-Frame-Options: DENY** on responses.

Example (Docker):

```yaml
environment:
  - BEACON_CORS_ORIGINS=https://your-app.example.com
  - BEACON_MAX_WS_CONNECTIONS=5000
  - BEACON_MAX_WS_PER_IP=100
```

### Cloudflare Tunnel / Reverse proxy

If you expose the beacon with **Cloudflare Tunnel** (or any reverse proxy):

1. **Forward both HTTP and WebSocket** to the beacon container (port 9001). The beacon serves:
   - **HTTP**: `GET /` and `GET /api/status` (live connection count page)
   - **WebSocket**: app connections
   on the **same port** (9001). The tunnel must proxy **all** traffic to that port, not only WebSocket.

2. If the **live status page** at your beacon URL shows **?** or never updates: the proxy is likely not forwarding HTTP. Configure the tunnel to send `https://your-beacon-domain` (all paths) to `http://localhost:9001` (or your NAS IP and port 9001).

3. **Cloudflare Web Analytics / Insights**: If you see console errors about `static.cloudflareinsights.com/beacon.min.js`, that’s Cloudflare’s script (unrelated to Cordia). You can disable it for the beacon host in the Cloudflare dashboard, or ignore the errors; they don’t affect the Cordia status page.

## Troubleshooting

### Port 9001 Already in Use

**Windows:**
```powershell
# Find process using port 9001
netstat -ano | findstr :9001

# Kill the process (replace PID with actual process ID)
taskkill /F /PID <PID>
```

**macOS/Linux:**
```bash
# Find and kill process on port 9001
lsof -ti:9001 | xargs kill -9
```

### Docker Not Running

- Make sure Docker Desktop is running
- Try `docker ps` to verify Docker is accessible
- Restart Docker Desktop if needed

### Live status page shows ? or doesn’t update

- The page at `https://your-beacon-domain/` (and `/api/status`) must be served by the Cordia beacon. If you use a reverse proxy or Cloudflare Tunnel, ensure **HTTP** (not only WebSocket) is forwarded to the beacon on port 9001. See **Cloudflare Tunnel / Reverse proxy** above.

### Count shows 0 even with the app open

- The count is **concurrent WebSocket connections** to this beacon. The Cordia app opens a connection when:
  1. You’re **logged in** and the beacon shows as **Connected** (sync/presence connection), or  
  2. You **join voice** in a chat.
- If the count stays 0: (1) In the app, go to **Settings → Connections** and confirm the beacon URL is this beacon (e.g. `wss://beacon.pkcollection.net`). (2) Make sure you’re logged in and the status dot is green. (3) If you use a proxy/tunnel, ensure **WebSocket** traffic is forwarded to the same beacon as HTTP; some setups route HTTP and WebSocket to different backends.

### App Shows "Offline" Status

1. **Verify signaling server is running:**
   ```bash
   docker-compose ps
   ```
   Should show `cordia-beacon` as "Up"

2. **Check server logs:**
   ```bash
   docker-compose logs signaling-server
   ```
   Look for "Signaling server listening on ws://127.0.0.1:9001"

3. **Restart the app:**
   - Close Cordia completely
   - Restart with `npm run tauri dev`
   - Check the connection indicator after app loads

### Docker Build Fails

```bash
# Clean up and rebuild
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Features Based on Connection

### ✅ With Signaling Server (Connected)
- Create multiple rooms per house
- Room persistence and metadata
- Automatic peer discovery
- Real-time presence tracking
- Voice participant visibility
- House invites and member management

### ⚠️ Without Signaling Server (Offline Mode)
- **Limited**: Single default chat per server only
- Room creation disabled
- Direct P2P connections still work
- Manual peer discovery required

## Production Deployment

For deploying to a public server or NAS, see **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)**.

## Next Steps

- Follow **[QUICKSTART.md](QUICKSTART.md)** to get the full app running
- See **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** for production deployment
- Check **[GITHUB_SETUP.md](GITHUB_SETUP.md)** for automated Docker builds
