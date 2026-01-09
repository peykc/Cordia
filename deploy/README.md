# Roommate Signaling Server Deployment

This directory contains the deployment configuration for running the Roommate signaling server on your NAS or server.

## Quick Deploy to Your NAS

### Step 1: Copy to Your NAS

Copy the `docker-compose.yml` file to your NAS:

```bash
# On your NAS
mkdir -p /mnt/App/stacks/roommate-signaling
cd /mnt/App/stacks/roommate-signaling

# Copy the docker-compose.yml file here
```

Or use this one-liner to download directly:

```bash
# Download from GitHub (after you push)
wget https://raw.githubusercontent.com/YOUR_USERNAME/roommate/main/deploy/docker-compose.yml
```

### Step 2: Update the Image Name

Edit `docker-compose.yml` and replace `YOUR_GITHUB_USERNAME` with your actual GitHub username:

```yaml
image: ghcr.io/YOUR_GITHUB_USERNAME/roommate-signaling:latest
```

For example: `ghcr.io/johndoe/roommate-signaling:latest`

### Step 3: Start the Server

```bash
docker-compose pull  # Pull the latest image
docker-compose up -d # Start in background
```

### Step 4: Verify It's Running

```bash
docker-compose ps
docker-compose logs -f signaling-server
```

You should see: `Signaling server listening on ws://127.0.0.1:9001`

## Configuration

### Volume Mount
Data is stored at: `/mnt/App/apps/signal`

This directory will be created automatically with proper permissions (PUID=1000, PGID=1000).

### Port
The server runs on port `9001` by default.

To change it, edit `docker-compose.yml`:
```yaml
ports:
  - "YOUR_PORT:9001"
```

### Timezone
Default is `America/New_York`. Change in `docker-compose.yml`:
```yaml
environment:
  - TZ=Your/Timezone
```

### User Permissions
Default is PUID=1000, PGID=1000. Change if needed:
```yaml
environment:
  - PUID=YOUR_UID
  - PGID=YOUR_GID
```

## Updating

To update to the latest version:

```bash
docker-compose pull
docker-compose up -d
```

## Management Commands

```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# Restart
docker-compose restart

# View logs
docker-compose logs -f signaling-server

# Check status
docker-compose ps
```

## Accessing from Roommate App

Once the server is running on your NAS, you'll need to update the Roommate app to use your NAS IP address instead of localhost.

**Example**: If your NAS IP is `192.168.1.100`:

Update `src-tauri/src/signaling.rs`:
```rust
pub fn get_default_signaling_url() -> String {
    "ws://192.168.1.100:9001".to_string()
}
```

Then rebuild the Roommate app.

## Troubleshooting

### Can't Connect
1. Check if server is running: `docker-compose ps`
2. Check logs: `docker-compose logs signaling-server`
3. Verify port is accessible: `telnet YOUR_NAS_IP 9001`

### Permission Issues
Make sure the volume directory has correct permissions:
```bash
ls -la /mnt/App/apps/signal
```

Should show UID 1000, GID 1000.

### Image Not Found
Make sure you:
1. Pushed your code to GitHub
2. GitHub Actions workflow completed successfully
3. Updated the image name in docker-compose.yml with your username

## Advanced: Building Locally

If you want to build the image locally instead of pulling from GitHub:

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/roommate.git
cd roommate

# Build and start
docker-compose up -d --build
```

This uses the main `docker-compose.yml` in the project root which builds from source.
