# Roommate

A privacy-focused P2P voice hangout app with modern usability. Built with Tauri, React, and Rust.

## Features

- 🎤 **P2P Voice Chat** - Direct peer-to-peer connections for low latency
- 🏠 **Houses & Rooms** - Organize conversations with persistent spaces
- 🔐 **Privacy-First** - Ed25519 identity, no central server required
- 🌐 **Hybrid Architecture** - Optional signaling server + DHT fallback
- 🎨 **Modern UI** - Clean, brutalist design with dark mode
- ⚙️ **Flexible Audio** - Voice activation or push-to-talk modes
- 🔄 **Graceful Degradation** - Works offline with reduced features

## Quick Start

### Prerequisites

- Node.js (v18+)
- Rust (latest stable)
- Docker & Docker Compose (for signaling server)

### 1. Start Signaling Server

```bash
docker-compose up -d
```

### 2. Start Roommate App

```bash
npm install
npm run tauri dev
```

See **[QUICKSTART.md](QUICKSTART.md)** for detailed instructions.

## Architecture

Roommate uses a hybrid P2P model:

- **Signaling Server** (optional): WebSocket server for peer discovery and room metadata
- **DHT Mode**: Distributed hash table for serverless peer discovery
- **Manual Mode**: Direct connections via LAN or manual key exchange

When the signaling server is unavailable, Roommate automatically falls back to limited functionality with a single default room per house.

## Connection Modes

### 🟢 With Signaling Server
- Create multiple rooms per house
- Room persistence and metadata
- Automatic peer discovery
- Presence tracking

### 🔴 Without Signaling Server
- Single default room per house
- Room creation disabled
- Direct P2P connections only
- Manual peer discovery

## Documentation

- **[Quick Start Guide](QUICKSTART.md)** - Get running in 3 steps
- **[Signaling Server Setup](SIGNALING_SETUP.md)** - Deploy the signaling server
- **[GitHub Setup](GITHUB_SETUP.md)** - Set up automatic Docker builds
- **[Windows Setup](SETUP.md)** - Windows development environment

## Project Structure

```
roommate/
├── src/                    # React frontend
│   ├── components/         # UI components
│   ├── contexts/           # React contexts (Identity, Signaling)
│   ├── lib/                # Utilities (audio, tauri bindings)
│   └── pages/              # Page components
├── src-tauri/              # Rust backend
│   └── src/
│       ├── identity.rs     # Ed25519 identity management
│       ├── house.rs        # House/room data structures
│       ├── signaling.rs    # Signaling health checks
│       └── audio_settings.rs
├── signaling-server/       # WebSocket signaling server
│   └── src/
│       └── main.rs
├── deploy/                 # Deployment configurations
└── docker-compose.yml      # Local development
```

## Technology Stack

**Frontend:**
- React 18 + TypeScript
- Vite
- TailwindCSS + shadcn/ui
- Lucide Icons

**Backend:**
- Tauri 1.5 (Rust + Web)
- Tokio (async runtime)
- Web Audio API

**Signaling Server:**
- Rust + Tokio
- tokio-tungstenite (WebSocket)

**Future:**
- WebRTC (for P2P connections)
- libp2p (for DHT)

## Development

### Run Locally

```bash
# Terminal 1: Signaling server
docker-compose up

# Terminal 2: Roommate app
npm run tauri dev
```

### Build for Production

```bash
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## Deployment

### Deploy Signaling Server to NAS/Server

See **[GITHUB_SETUP.md](GITHUB_SETUP.md)** for setting up automatic Docker builds.

Quick deploy:
```bash
# On your server
mkdir -p /mnt/App/stacks/roommate-signaling
cd /mnt/App/stacks/roommate-signaling
wget https://raw.githubusercontent.com/YOUR_USERNAME/roommate/main/deploy/docker-compose.yml
docker-compose pull
docker-compose up -d
```

## Roadmap

### ✅ Phase 1: Foundation (Complete)
- User identity (Ed25519)
- House creation and joining
- Room management
- Audio settings UI
- Voice activation & push-to-talk

### ✅ Phase 2: Signaling Infrastructure (Complete)
- WebSocket signaling server
- Connection health checks
- Status indicators & graceful degradation
- Docker deployment with GitHub Actions

### 🚧 Phase 3: P2P Voice (In Progress)
- WebRTC peer connections
- SDP offer/answer exchange
- ICE candidate handling
- Audio pipeline integration

### 📋 Phase 4: Enhanced Features (Planned)
- DHT mode (libp2p)
- Room persistence
- Offline messages
- Presence tracking

### 📋 Phase 5: Polish (Planned)
- Text chat
- File sharing
- Mobile support
- End-to-end encryption

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[Your chosen license - MIT, Apache 2.0, etc.]

## Inspiration

Roommate aims to be the "best private alternative to Tox/Jami with modern usability" - focusing on small groups, privacy, and a smooth user experience.

