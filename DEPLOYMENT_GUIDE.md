# Deployment Guide

Simple guide for deploying your own Cordia beacon to your NAS or server.

**Note:** Cordia comes with a default beacon at `beacon.pkcollection.net` that you can use immediately. You only need to deploy your own beacon if you want full control over your infrastructure.

**Privacy:** The beacon cannot read your user data. All server data, chat content, and messages are encrypted and stored locally on your device. The beacon only facilitates peer discovery and presence tracking. Your voice communication is direct peer-to-peer and never passes through the server.

You can change the beacon URL at any time in Settings → Connections, and each account can use a different server.

## Installation Methods

### 🖱️ Method 1: Dockge/Portainer (Easiest!)

If you have Dockge, Portainer, or any Docker GUI:

1. Open your Docker manager in a browser
2. Create a new stack/compose named `cordia-beacon`
3. Copy-paste this configuration:

```yaml
version: '3.8'

services:
  cordia-beacon:
    image: ghcr.io/YOUR_USERNAME/cordia-beacon:latest
    container_name: cordia-beacon
    hostname: cordia-beacon
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
      - RUST_LOG=info
    volumes:
      - /mnt/App/apps/signal:/config
    ports:
      - "9001:9001"
    restart: unless-stopped

networks: {}
```

**Important:** Replace `YOUR_USERNAME` with your actual GitHub username.

4. Click "Deploy" or "Start"

✅ **Done!** Check the container logs to verify it's running.

See **[deploy/DOCKGE_SETUP.md](deploy/DOCKGE_SETUP.md)** for detailed instructions.

---

### 💻 Method 2: One-Command Installation

SSH into your NAS/server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Pey-K/Cordia/main/deploy/install.sh | bash
```

That's it! The installer will:
- ✅ Create all necessary directories
- ✅ Download the configuration
- ✅ Pull the Docker image
- ✅ Start the beacon
- ✅ Set up proper permissions

**Verify it's working:**
```bash
cd /mnt/App/stacks/roommate-signaling
docker-compose logs -f cordia-beacon
```

You should see: `Signaling server listening on ws://127.0.0.1:9001`

---

### 📝 Method 3: Manual Installation

If you prefer manual setup:

```bash
# Create directory
mkdir -p /mnt/App/stacks/roommate-signaling
cd /mnt/App/stacks/roommate-signaling

# Download configuration
wget https://raw.githubusercontent.com/Pey-K/Cordia/main/deploy/docker-compose.yml

# Update image name with your username
# Edit docker-compose.yml and replace YOUR_USERNAME

# Start server
docker-compose pull
docker-compose up -d
```

## Configuration

### Find Your Server IP

You'll need your NAS/server's IP address to connect the Cordia app:

```bash
hostname -I | awk '{print $1}'
```

This will show something like: `192.168.1.100`

### Update App Configuration

The Cordia app needs to be configured with your server's IP address. The developer needs to update:

**File:** `src-tauri/src/signaling.rs`

```rust
pub fn get_default_signaling_url() -> String {
    "ws://YOUR_NAS_IP:9001".to_string()  // Replace with your actual IP
}
```

Then rebuild the app: `npm run tauri build`

## Managing the Server

All commands should be run from the installation directory:

```bash
cd /mnt/App/stacks/roommate-signaling
```

### View Logs
```bash
docker-compose logs -f cordia-beacon
```

### Stop Server
```bash
docker-compose down
```

### Start Server
```bash
docker-compose up -d
```

### Restart Server
```bash
docker-compose restart
```

### Update to Latest Version
```bash
docker-compose pull
docker-compose up -d
```

### Check Status
```bash
docker-compose ps
```

## Troubleshooting

### Can't Access from Other Devices

1. **Check if server is running:**
   ```bash
   docker-compose ps
   ```

2. **Check firewall:**
   - Make sure port 9001 is open
   - On most NAS systems: Control Panel → Security → Firewall
   - Add rule to allow port 9001

3. **Test connection:**
   ```bash
   telnet YOUR_NAS_IP 9001
   ```

### Server Not Starting

1. **Check logs:**
   ```bash
   docker-compose logs cordia-beacon
   ```

2. **Check if port is in use:**
   ```bash
   netstat -tlnp | grep 9001
   ```

3. **Rebuild and restart:**
   ```bash
   docker-compose down
   docker-compose up -d --build
   ```

### Permission Issues

If you see permission errors:

```bash
sudo chown -R 1000:1000 /mnt/App/apps/signal
```

## Uninstalling

To completely remove the beacon:

```bash
cd /mnt/App/stacks/roommate-signaling
docker-compose down
docker rmi ghcr.io/YOUR_USERNAME/cordia-beacon:latest
rm -rf /mnt/App/stacks/roommate-signaling
# Optionally remove data
rm -rf /mnt/App/apps/signal
```

## Custom Installation Directory

To use a custom installation directory:

```bash
curl -fsSL https://raw.githubusercontent.com/Pey-K/Cordia/main/deploy/install.sh | INSTALL_DIR=/your/custom/path bash
```

**Note:** You'll also need to update the data volume path in docker-compose.yml.

## Next Steps

Once the beacon is running:

1. ✅ Server is running on your NAS
2. ⏭️ Configure the Cordia app with your NAS IP
3. ⏭️ Distribute the app to your friends
4. ⏭️ Start voice chatting!

## Getting Help

- Check logs: `docker-compose logs -f cordia-beacon`
- Verify Docker: `docker ps`
- See [SIGNALING_SETUP.md](SIGNALING_SETUP.md) for local development setup
- See [GITHUB_SETUP.md](GITHUB_SETUP.md) for automated builds
