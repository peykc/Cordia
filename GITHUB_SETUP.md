# GitHub Actions Setup Guide

This guide will help you set up automatic Docker image builds using GitHub Actions.

## Overview

GitHub Actions will automatically build and push the beacon Docker image to GitHub Container Registry (ghcr.io) whenever you push code to the repository.

## Prerequisites

- A GitHub account
- A GitHub repository (public or private)
- Git initialized in your project

## Step 1: Push Your Code to GitHub

If you haven't already:

```bash
# Initialize git (if not already done)
git init

# Add all files
git add .

# Create first commit
git commit -m "Initial commit: Cordia P2P voice chat app"

# Add remote (replace YOUR_USERNAME with your GitHub username)
git remote add origin https://github.com/YOUR_USERNAME/Cordia.git

# Push to GitHub
git branch -M main
git push -u origin main
```

## Step 2: Verify GitHub Actions Workflow

The workflow file should already exist at `.github/workflows/docker-build.yml`.

1. Go to your repository on GitHub
2. Click the **Actions** tab
3. You should see the workflow "Build and Push Cordia Beacon"

After your first push, the workflow will automatically run and build the Docker image.

## Step 3: Wait for Build to Complete

1. Go to **Actions** tab in your repository
2. Click on the running workflow
3. Wait for it to complete (usually 2-5 minutes)
4. Once complete, your Docker image will be available at:
   ```
   ghcr.io/YOUR_USERNAME/cordia-beacon:latest
   ```

## Step 4: Update Deployment Configuration

Update `deploy/docker-compose.yml` with your actual GitHub username:

```yaml
image: ghcr.io/YOUR_ACTUAL_USERNAME/cordia-beacon:latest
```

Commit and push this change:

```bash
git add deploy/docker-compose.yml
git commit -m "Update docker image name with actual username"
git push
```

## Step 5: Enable GitHub Container Registry

**For Public Images** (default):
- No additional setup needed
- Images are public by default

**For Private Images**:
1. Go to repository **Settings** → **Actions** → **General**
2. Under **Workflow permissions**, ensure "Read and write permissions" is checked
3. Click **Save**

## How It Works

The GitHub Actions workflow:

1. **Triggers** on push to `main` branch
2. **Builds** the beacon Docker image
3. **Pushes** to GitHub Container Registry
4. **Tags** as `latest` and with the commit SHA

## Manual Trigger

You can also manually trigger the workflow:

1. Go to **Actions** tab
2. Select "Build and Push Cordia Beacon"
3. Click **Run workflow**
4. Select branch and click **Run workflow**

## Updating the Image

Every time you push code to the `main` branch, a new image will be built automatically. To use the latest image:

```bash
# On your deployment server
docker-compose pull
docker-compose up -d
```

## Troubleshooting

### Workflow Fails

1. Check the **Actions** tab for error messages
2. Common issues:
   - Missing Dockerfile
   - Build errors in beacon-server
   - Permission issues with ghcr.io

### Image Not Found

- Make sure the workflow completed successfully
- Check that the image name matches your username
- Verify the image is public (or you're authenticated if private)

### Authentication Required

If using private images, you may need to authenticate:

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin
```

## Next Steps

- See **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** to deploy your built image
- See **[BEACON_SETUP.md](BEACON_SETUP.md)** for local development setup
