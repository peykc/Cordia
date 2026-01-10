# Roommate Deployment Guide for Users

Super simple guide for deploying the Roommate signaling server to your NAS or server.

## For Users: Installing the Signaling Server

### Step 1: SSH to Your NAS

Connect to your NAS via SSH:
```bash
ssh your-username@your-nas-ip
```

### Step 2: Run the One-Line Installer

Copy and paste this command:

```bash
curl -fsSL https://raw.githubusercontent.com/Pey-K/Roommate/main/deploy/install.sh | bash
```

That's it! The installer will:
- ✅ Create all necessary directories
- ✅ Download the configuration
- ✅ Pull the Docker image
- ✅ Start the signaling server
- ✅ Set up proper permissions (PUID 1000, PGID 1000)

### Step 3: Verify It's Working

You should see output like:
```
🎉 Installation complete!

Your signaling server is now running at ws://localhost:9001
Data will be stored at: /mnt/App/apps/signal
```

To check the logs:
```bash
cd /mnt/App/stacks/roommate-signaling
docker-compose logs -f signaling-server
```

You should see:
```
Signaling server listening on ws://127.0.0.1:9001
```

Press `Ctrl+C` to stop viewing logs (server keeps running).

### Step 4: Find Your NAS IP Address

You'll need your NAS's local IP address to connect the Roommate app.

**On your NAS**, run:
```bash
hostname -I | awk '{print $1}'
```

This will show something like: `192.168.1.100`

**Write this down!** You'll need it to configure the Roommate app.

## What Was Installed?

### Directories Created:
- **Installation**: `/mnt/App/stacks/roommate-signaling/`
  - Contains the docker-compose.yml configuration
- **Data Storage**: `/mnt/App/apps/signal/`
  - Docker creates this automatically
  - Stores logs and future configuration

### Docker Container:
- **Name**: `roommate-signaling`
- **Port**: 9001
- **Restart Policy**: Automatically restarts if it crashes or NAS reboots

## Managing the Server

All commands should be run from the installation directory:
```bash
cd /mnt/App/stacks/roommate-signaling
```

### View Logs
```bash
docker-compose logs -f signaling-server
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
When a new version is released:
```bash
docker-compose pull
docker-compose up -d
```

### Check Status
```bash
docker-compose ps
```

Should show:
```
NAME                  STATUS
roommate-signaling    Up 5 minutes (healthy)
```

## Connecting Roommate App to Your Server

After the signaling server is running on your NAS, you need to configure the Roommate app to use it.

### Find Your Server Address

Your signaling server URL will be:
```
ws://YOUR_NAS_IP:9001
```

For example, if your NAS IP is `192.168.1.100`:
```
ws://192.168.1.100:9001
```

### Configure the App

The app developer needs to update the default signaling URL in the code and rebuild the app for you.

**File to modify**: `src-tauri/src/signaling.rs`

Change:
```rust
pub fn get_default_signaling_url() -> String {
    "ws://127.0.0.1:9001".to_string()
}
```

To:
```rust
pub fn get_default_signaling_url() -> String {
    "ws://192.168.1.100:9001".to_string()  // Your NAS IP
}
```

Then rebuild: `npm run tauri build`

## Troubleshooting

### Can't Access Server from Other Devices

If you can't connect to the signaling server from other devices on your network:

1. **Check if server is running:**
   ```bash
   cd /mnt/App/stacks/roommate-signaling
   docker-compose ps
   ```

2. **Check firewall on NAS:**
   Make sure port 9001 is open. On most NAS systems:
   - Go to Control Panel → Security → Firewall
   - Add rule to allow port 9001

3. **Test connection from another device:**
   ```bash
   telnet YOUR_NAS_IP 9001
   ```

   If it connects, you should see the connection in the logs:
   ```bash
   docker-compose logs signaling-server
   ```

### Server Not Starting

1. **Check logs for errors:**
   ```bash
   docker-compose logs signaling-server
   ```

2. **Check if port 9001 is already in use:**
   ```bash
   netstat -tlnp | grep 9001
   ```

3. **Restart Docker:**
   ```bash
   # On Synology NAS
   sudo synoservicectl --restart pkgctl-Docker

   # On most Linux systems
   sudo systemctl restart docker
   ```

4. **Rebuild and restart:**
   ```bash
   docker-compose down
   docker-compose up -d --build
   ```

### Permission Issues

If you see permission errors in the logs:

1. **Check volume permissions:**
   ```bash
   ls -la /mnt/App/apps/signal
   ```

2. **Should show UID 1000, GID 1000**

3. **Fix permissions if needed:**
   ```bash
   sudo chown -R 1000:1000 /mnt/App/apps/signal
   ```

### Installation Failed

If the installation script fails:

1. **Check internet connection:**
   ```bash
   ping github.com
   ```

2. **Check Docker is installed:**
   ```bash
   docker --version
   docker-compose --version
   ```

3. **Try manual installation instead:**
   ```bash
   mkdir -p /mnt/App/stacks/roommate-signaling
   cd /mnt/App/stacks/roommate-signaling
   wget https://raw.githubusercontent.com/Pey-K/Roommate/main/deploy/docker-compose.yml
   docker-compose pull
   docker-compose up -d
   ```

## Uninstalling

To completely remove the signaling server:

```bash
# Stop and remove container
cd /mnt/App/stacks/roommate-signaling
docker-compose down

# Remove Docker image
docker rmi ghcr.io/pey-k/roommate-signaling:latest

# Remove installation directory
rm -rf /mnt/App/stacks/roommate-signaling

# Optionally remove data directory
rm -rf /mnt/App/apps/signal
```

## Custom Installation Directory

If you don't want to use the default location:

```bash
curl -fsSL https://raw.githubusercontent.com/Pey-K/Roommate/main/deploy/install.sh | INSTALL_DIR=/your/custom/path bash
```

**Note**: You'll also need to update the data volume path in docker-compose.yml if you want data stored elsewhere.

## Getting Help

If you're stuck:
1. Check the logs: `docker-compose logs -f signaling-server`
2. Verify Docker is working: `docker ps`
3. Check GitHub issues: https://github.com/Pey-K/Roommate/issues

## Next Steps

Once the signaling server is running:
1. ✅ Server is running on your NAS
2. ⏭️ Get the Roommate app configured with your NAS IP
3. ⏭️ Distribute the app to your friends
4. ⏭️ Start voice chatting!
