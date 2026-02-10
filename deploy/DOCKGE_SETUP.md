# Cordia Beacon - Dockge/Portainer Setup

Easy setup using Dockge, Portainer, or any Docker GUI manager.

## For Dockge Users

### Method 1: Copy-Paste (Easiest)

1. Open Dockge in your browser
2. Click **"+ Compose"** or **"Create Stack"**
3. Name it: `cordia-beacon`
4. Paste this docker-compose.yml:

```yaml
version: '3.8'

services:
  cordia-beacon:
    image: ghcr.io/pey-k/cordia-beacon:latest
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
    healthcheck:
      test: ["/app/cordia-beacon", "--healthcheck"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s

networks: {}
```

5. Click **"Deploy"** or **"Start"**

That's it! Dockge will:
- Pull the Docker image automatically
- Create `/mnt/App/apps/signal` directory with proper permissions
- Start the beacon

### Method 2: Import from URL

Some container managers support importing from URL:

1. Create new stack/compose
2. Import from URL: `https://raw.githubusercontent.com/Pey-K/Cordia/main/deploy/docker-compose.yml`
3. Deploy

## For Portainer Users

### Step 1: Create Stack

1. Go to **Stacks** → **Add Stack**
2. Name: `cordia-beacon`
3. Choose **Web editor**

### Step 2: Paste Configuration

Copy and paste:

```yaml
version: '3.8'

services:
  cordia-beacon:
    image: ghcr.io/pey-k/cordia-beacon:latest
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
    healthcheck:
      test: ["/app/cordia-beacon", "--healthcheck"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s

networks: {}
```

### Step 3: Deploy

Click **"Deploy the stack"**

## For Other Docker GUIs

Works with any Docker management tool:
- **Yacht**
- **Lazydocker**
- **Synology Container Manager**
- **UNRAID Docker**
- **CasaOS**

Just import or paste the docker-compose.yml shown above.

## Customization

### Change Data Storage Location

Edit the volumes section:
```yaml
volumes:
  - /your/custom/path:/config  # Change left side only
```

### Change Timezone

Edit the TZ environment variable:
```yaml
- TZ=America/Los_Angeles  # or Europe/London, Asia/Tokyo, etc.
```

### Change Port

Edit the ports section:
```yaml
ports:
  - "YOUR_PORT:9001"  # Change left side only
```

### Change User/Group ID

Edit PUID/PGID:
```yaml
- PUID=1001  # Your user ID
- PGID=1001  # Your group ID
```

To find your UID/GID, SSH to your NAS and run:
```bash
id
```

## Verifying Installation

### Check Container Status

In your container manager, the container should show:
- **Status**: Running
- **Health**: Healthy (after 10 seconds)
- **Port**: 9001

### View Logs

Click on the container and view logs. You should see:
```
Beacon listening on ws://127.0.0.1:9001
```

### Test Connection

From another device on your network:
```bash
telnet YOUR_NAS_IP 9001
```

Should connect successfully.

## Updating

When a new version is released:

### In Dockge:
1. Click the stack
2. Click **"Pull & Restart"** or **"Recreate"**

### In Portainer:
1. Go to Stacks → cordia-beacon
2. Click **"Pull and redeploy"**

### Manual Update:
Stop the container, pull new image, start again:
```bash
docker pull ghcr.io/pey-k/cordia-beacon:latest
# Then restart container in your GUI
```

## Troubleshooting

### Container Won't Start

**Check logs in your container manager**

Common issues:
- Port 9001 already in use → Change to different port
- Permission issues → Check PUID/PGID match your user
- Volume path doesn't exist → It will be created automatically, but parent must exist

### Can't Connect from Other Devices

1. **Check firewall** - Allow port 9001
2. **Check container is running** - Should show "Running" status
3. **Check health status** - Should show "Healthy"

### Health Check Fails

The health check uses `nc` (netcat). If it fails:

1. **Remove health check** (optional) - Comment out or delete the healthcheck section
2. **Check logs** - Container might still be working even if health check fails

Simplified version without health check:
```yaml
version: '3.8'

services:
  cordia-beacon:
    image: ghcr.io/pey-k/cordia-beacon:latest
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

## Getting Your NAS IP

You'll need this to configure the Cordia app.

### Method 1: In your Docker GUI
Most show the host IP in the dashboard

### Method 2: SSH
```bash
hostname -I | awk '{print $1}'
```

### Method 3: Router
Check your router's connected devices list

## Next Steps

Once the container is running:
1. ✅ Note your NAS IP address
2. ✅ Verify port 9001 is accessible
3. ⏭️ Configure Cordia app with your NAS IP
4. ⏭️ Start chatting!

## Support

- **Logs**: Always check container logs first
- **GitHub Issues**: https://github.com/Pey-K/Cordia/issues
- **Docker Docs**: Your container manager's documentation
