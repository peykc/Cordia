#!/bin/bash
set -e

echo "🏠 Cordia Beacon Installer"
echo "========================="
echo ""

# Default installation directory
INSTALL_DIR="${INSTALL_DIR:-/mnt/App/stacks/cordia-beacon}"

echo "📁 Installation directory: $INSTALL_DIR"
echo ""

# Create installation directory
echo "Creating installation directory..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Download docker-compose.yml
echo "Downloading configuration..."
curl -fsSL https://raw.githubusercontent.com/Pey-K/Cordia/main/deploy/docker-compose.yml -o docker-compose.yml

echo ""
echo "✅ Configuration downloaded successfully!"
echo ""

# Pull and start
echo "Pulling Docker image (this may take a few minutes)..."
docker-compose pull

echo ""
echo "Starting beacon..."
docker-compose up -d

echo ""
echo "🎉 Installation complete!"
echo ""
echo "Your beacon is now running at ws://localhost:9001"
echo "Data will be stored at: /mnt/App/apps/signal"
echo ""
echo "Useful commands:"
echo "  View logs:    docker-compose logs -f cordia-beacon"
echo "  Stop beacon:  docker-compose down"
echo "  Restart:      docker-compose restart"
echo "  Update:       docker-compose pull && docker-compose up -d"
echo ""
echo "Installation directory: $INSTALL_DIR"
