# Cordia Beacon Deployment

This directory contains the deployment configuration for running the Cordia beacon on your NAS or server.

## 🎯 Choose Your Installation Method

### 🖱️ **Recommended: Use Dockge/Portainer** (GUI - Easiest!)

If you use Dockge, Portainer, or any Docker GUI manager, this is the easiest method.

**See [DOCKGE_SETUP.md](DOCKGE_SETUP.md) for detailed instructions.**

**Quick version:**
1. Open your Docker manager (Dockge/Portainer/etc.)
2. Create new stack named `cordia-beacon`
3. Copy-paste the docker-compose.yml (see DOCKGE_SETUP.md)
4. Deploy!

---

## 💻 Command Line Installation

### 🚀 One-Command Installation

SSH into your NAS/server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Pey-K/Cordia/main/deploy/install.sh | bash
```

That's it! The script will:
- Create the installation directory at `/mnt/App/stacks/cordia-beacon`
- Download the configuration
- Pull the Docker image
- Start the server
- Create the data directory at `/mnt/App/apps/signal` (automatically)

**Custom installation directory:**
```bash
curl -fsSL https://raw.githubusercontent.com/Pey-K/Cordia/main/deploy/install.sh | INSTALL_DIR=/your/custom/path bash
```

### Verify It's Running

```bash
cd /mnt/App/stacks/cordia-beacon
docker-compose logs -f cordia-beacon
```

You should see: `Beacon listening on ws://127.0.0.1:9001`

---

## 📝 Manual Installation (Alternative)

If you prefer manual installation:

### Step 1: Download and Start

```bash
mkdir -p /mnt/App/stacks/cordia-beacon
cd /mnt/App/stacks/cordia-beacon
wget https://raw.githubusercontent.com/Pey-K/Cordia/main/deploy/docker-compose.yml
docker-compose pull
docker-compose up -d
```

### Step 2: Verify

```bash
docker-compose ps
docker-compose logs -f cordia-beacon
```

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
docker-compose logs -f cordia-beacon

# Check status
docker-compose ps
```

## Accessing from Cordia App

You do **not** need to rebuild Cordia to point at your beacon.

In the app, go to **Settings → Connections** and set your beacon URL, for example:

- `ws://192.168.1.100:9001` (LAN)
- `wss://beacon.yourdomain.com` (recommended when exposed publicly behind TLS)

## Troubleshooting

### Can't Connect
1. Check if server is running: `docker-compose ps`
2. Check logs: `docker-compose logs cordia-beacon`
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
git clone https://github.com/YOUR_USERNAME/Cordia.git
cd Cordia

# Build and start
docker-compose up -d --build
```

This uses the main `docker-compose.yml` in the project root which builds from source.
