# Signaling Server Setup Guide

This guide will help you get the Roommate signaling server up and running for local development.

## Prerequisites

- **Docker** and **Docker Compose**
  - Windows: [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
  - macOS: [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
  - Linux: [Docker Engine](https://docs.docker.com/engine/install/)

## Quick Start

### Start the Signaling Server

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

You should see: `Signaling server listening on ws://127.0.0.1:9001`

## Connection Status in App

Once the app is running, check the connection status:

- **🟢 Green "Connected"**: Signaling server is online - full features available
- **🟡 Yellow "Checking"**: Checking connection status
- **🔴 Red "Offline"**: Signaling server offline - limited to single room per house

## Managing the Server

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

## Alternative: Run Without Docker (Development)

If you prefer to run the signaling server directly with Rust:

```bash
# Terminal 1 - Signaling Server
cd signaling-server
RUST_LOG=info cargo run

# Terminal 2 - Roommate App (from project root)
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

The signaling server stores data in `/mnt/App/apps/signal` on the host machine (for production deployments). For local development, data is stored in Docker volumes.

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

### App Shows "Offline" Status

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

3. **Restart the app:**
   - Close Roommate completely
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
- **Limited**: Single default room per house only
- Room creation disabled
- Direct P2P connections still work
- Manual peer discovery required

## Production Deployment

For deploying to a public server or NAS, see **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)**.

## Next Steps

- Follow **[QUICKSTART.md](QUICKSTART.md)** to get the full app running
- See **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** for production deployment
- Check **[GITHUB_SETUP.md](GITHUB_SETUP.md)** for automated Docker builds
