# GitHub Repository Setup Guide

This guide will help you set up the GitHub repository for automatic Docker image builds.

## Step 1: Initialize Git Repository

```bash
# In your project directory
cd "C:\Users\peyto\Documents\!My Games\Roommate"

# Initialize git (if not already done)
git init

# Add all files
git add .

# Create first commit
git commit -m "Initial commit: Roommate P2P voice chat app with signaling server"
```

## Step 2: Create GitHub Repository

1. Go to [GitHub](https://github.com)
2. Click the **+** icon in top-right → **New repository**
3. Name it: `roommate` (or your preferred name)
4. Description: "Privacy-focused P2P voice chat app with hybrid DHT/signaling architecture"
5. Choose **Public** or **Private** (your preference)
6. **Do NOT** initialize with README, .gitignore, or license (we already have these)
7. Click **Create repository**

## Step 3: Push to GitHub

GitHub will show you commands like this:

```bash
# Add the remote
git remote add origin https://github.com/YOUR_USERNAME/roommate.git

# Push to GitHub
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

## Step 4: Enable GitHub Actions

GitHub Actions should be enabled by default for your repository.

To verify:
1. Go to your repository on GitHub
2. Click the **Actions** tab
3. You should see the workflow "Build and Push Signaling Server"

After your first push, the workflow will automatically run and build the Docker image.

## Step 5: Enable GitHub Container Registry

The Docker images will be published to GitHub Container Registry (ghcr.io).

**For Public Images** (default):
- No additional setup needed
- Images are public by default

**For Private Images**:
1. Go to repository **Settings** → **Actions** → **General**
2. Under **Workflow permissions**, ensure "Read and write permissions" is checked
3. Click **Save**

## Step 6: Wait for Build to Complete

1. Go to **Actions** tab in your repository
2. Click on the running workflow
3. Wait for it to complete (usually 2-5 minutes)
4. Once complete, your Docker image will be available at:
   ```
   ghcr.io/YOUR_USERNAME/roommate-signaling:latest
   ```

## Step 7: Update Deployment Configuration

Update `deploy/docker-compose.yml` with your actual GitHub username:

```yaml
image: ghcr.io/YOUR_ACTUAL_USERNAME/roommate-signaling:latest
```

Commit and push this change:
```bash
git add deploy/docker-compose.yml
git commit -m "Update docker image name with actual username"
git push
```

## Step 8: Deploy to Your NAS

Now you can deploy to your NAS:

```bash
# On your NAS
mkdir -p /mnt/App/stacks/roommate-signaling
cd /mnt/App/stacks/roommate-signaling

# Download the docker-compose file
wget https://raw.githubusercontent.com/YOUR_USERNAME/roommate/main/deploy/docker-compose.yml

# Or use curl
curl -o docker-compose.yml https://raw.githubusercontent.com/YOUR_USERNAME/roommate/main/deploy/docker-compose.yml

# Pull and start
docker-compose pull
docker-compose up -d

# Check logs
docker-compose logs -f signaling-server
```

## Automatic Updates

Every time you push changes to the `signaling-server/` directory, GitHub Actions will automatically:
1. Build a new Docker image
2. Push it to GitHub Container Registry
3. Tag it as `latest`

To update your NAS:
```bash
docker-compose pull
docker-compose up -d
```

## Workflow Triggers

The Docker build workflow runs when:
- You push to `main` or `master` branch
- Changes are made to `signaling-server/` directory
- Changes are made to the workflow file itself
- You manually trigger it from GitHub Actions tab

## Repository Structure

After setup, your repository will have:

```
roommate/
├── .github/
│   └── workflows/
│       └── docker-build.yml       # Auto-builds Docker image
├── deploy/
│   ├── docker-compose.yml         # For deploying on NAS
│   └── README.md                  # Deployment instructions
├── signaling-server/
│   ├── src/
│   │   └── main.rs
│   ├── Cargo.toml
│   ├── Dockerfile
│   └── entrypoint.sh
├── src-tauri/                     # Tauri backend
├── src/                           # React frontend
├── docker-compose.yml             # For local development
├── package.json
└── README.md
```

## Viewing Your Published Images

To see your published Docker images:
1. Go to your GitHub profile
2. Click **Packages** tab
3. You'll see `roommate-signaling`
4. Click it to see all versions/tags

## Making Images Public

If your repository is private but you want the Docker image to be public:

1. Go to the package page (GitHub Profile → Packages → roommate-signaling)
2. Click **Package settings**
3. Scroll down to **Danger Zone**
4. Click **Change visibility** → **Public**

## Troubleshooting

### Workflow Fails with Permission Error

1. Go to repository **Settings** → **Actions** → **General**
2. Under **Workflow permissions**, select "Read and write permissions"
3. Click **Save**
4. Re-run the workflow

### Can't Pull Image on NAS

If you get "unauthorized" error when pulling:

**For public images:**
```bash
docker logout ghcr.io
docker-compose pull
```

**For private images:**
You need to authenticate:
```bash
# Create a Personal Access Token (PAT) on GitHub with read:packages scope
# Then login:
echo YOUR_PAT | docker login ghcr.io -u YOUR_USERNAME --password-stdin

# Then pull
docker-compose pull
```

### Build Takes Too Long

The first build takes 5-10 minutes because it compiles Rust from scratch.
Subsequent builds are faster due to caching (usually 2-3 minutes).

## Next Steps

After setup is complete:

1. ✅ Repository is on GitHub
2. ✅ Docker image builds automatically
3. ✅ Image is published to ghcr.io
4. ✅ Can deploy to NAS with `docker-compose pull && docker-compose up -d`
5. ⏭️ Update Roommate app to point to your NAS IP
6. ⏭️ Build and distribute Roommate app to friends

## Helpful Links

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
