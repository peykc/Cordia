# Roommate

A privacy-focused P2P voice hangout app with modern usability. Built with Tauri, React, and Rust.

## Features

- 🎤 **P2P Voice Chat** - Direct peer-to-peer WebRTC connections for low latency voice communication
- 🏠 **Houses & Rooms** - Organize conversations with persistent spaces and room management
- 👥 **Real-time Presence** - See who's online, active, or in a call with color-coded status indicators
- 🗣️ **Voice Activity Detection** - Visual indicators show who's speaking in real-time
- 🔐 **Privacy-First** - Ed25519 identity, end-to-end encrypted communication, no central server required. The signaling server cannot read your data - all house data is encrypted and stored locally.
- 🌐 **Hybrid Architecture** - Optional signaling server for enhanced features with graceful fallback
- 🎨 **Modern UI** - Clean, brutalist design with dark mode and Discord-inspired UX
- ⚙️ **Flexible Audio** - Voice activation or push-to-talk modes with device hot-swapping
- 🔄 **Multi-Account Support** - Run multiple independent instances with separate data directories
- 📦 **Account Export/Import** - Backup and restore your identity and house keys

## Quick Start

### Prerequisites

- **Node.js** (v18 or higher)
- **Rust** (latest stable)
- **Docker & Docker Compose** (for self-hosting signaling server - optional)

### 1. Signaling Server

Roommate comes with a default signaling server at `signal.pkcollection.net` that you can use immediately. No setup required!

**Option A: Use Default Server (Recommended for Quick Start)**
- The app automatically connects to `signal.pkcollection.net`
- No configuration needed
- Full features available immediately
- **Privacy:** The server cannot read your data - all house data is encrypted and stored locally

**Option B: Self-Host Your Own Server (Optional)**
```bash
docker-compose up -d
```
See **[SIGNALING_SETUP.md](SIGNALING_SETUP.md)** for details.

**Note:** You can change the signaling server URL at any time in Settings → Connections. Each account can use a different server.

### 2. Start Roommate App

```bash
npm install
npm run tauri dev
```

See **[QUICKSTART.md](QUICKSTART.md)** for detailed step-by-step instructions.

## Architecture

Roommate uses a hybrid P2P model that gracefully degrades based on available infrastructure:

- **Signaling Server** (optional): WebSocket server for peer discovery, room metadata, and presence tracking
  - **Default Server**: `signal.pkcollection.net` (hosted for your convenience)
  - **Self-Hosted**: Run your own server for full control (see [SIGNALING_SETUP.md](SIGNALING_SETUP.md))
  - **Per-Account**: Each account can use a different signaling server
  - **Privacy**: The signaling server cannot read your user data - all house data and messages are encrypted and stored locally
- **WebRTC P2P**: Direct peer-to-peer connections for voice communication
- **Local Storage**: Houses and rooms are stored locally with encrypted keys

When the signaling server is unavailable, Roommate automatically falls back to limited functionality with a single default room per house.

## Connection Modes

### 🟢 With Signaling Server
- ✅ Create multiple rooms per house
- ✅ Room persistence and metadata
- ✅ Automatic peer discovery
- ✅ Real-time presence tracking (online, active, in call)
- ✅ Voice participant visibility
- ✅ House invites and member management

### 🔴 Without Signaling Server
- ⚠️ Single default room per house
- ⚠️ Room creation disabled
- ✅ Direct P2P connections still work
- ⚠️ Manual peer discovery required

## Documentation

- **[Quick Start Guide](QUICKSTART.md)** - Get running in 3 steps
- **[Windows Setup](SETUP.md)** - Windows development environment setup
- **[Signaling Server Setup](SIGNALING_SETUP.md)** - Deploy the signaling server
- **[Deployment Guide](DEPLOYMENT_GUIDE.md)** - Deploy to your NAS or server
- **[GitHub Setup](GITHUB_SETUP.md)** - Set up automatic Docker builds

## Project Structure

```
roommate/
├── src/                    # React frontend
│   ├── components/         # UI components (UserCard, TitleBar, etc.)
│   ├── contexts/           # React contexts (Identity, Signaling, WebRTC, Presence)
│   ├── lib/                # Utilities (audio, tauri bindings, remote audio analyzer)
│   └── pages/              # Page components (HouseList, HouseView, Settings)
├── src-tauri/              # Rust backend (Tauri)
│   └── src/
│       ├── identity.rs     # Ed25519 identity management
│       ├── house.rs        # House/room data structures and encryption
│       ├── account_manager.rs  # Multi-account support
│       └── main.rs         # Tauri commands and app initialization
├── signaling-server/       # WebSocket signaling server (Rust)
│   └── src/
│       └── main.rs         # Signaling server implementation
├── deploy/                 # Deployment configurations
│   ├── docker-compose.yml  # Production deployment config
│   └── install.sh          # One-command installation script
└── docker-compose.yml      # Local development
```

## Technology Stack

**Frontend:**
- React 18 + TypeScript
- Vite (build tool and dev server)
- TailwindCSS + shadcn/ui components
- Lucide Icons
- React Router for navigation

**Backend:**
- Tauri 1.5 (Rust + Web)
- Tokio (async runtime)
- Web Audio API for audio processing
- Ed25519 for cryptographic identity

**Signaling Server:**
- Rust + Tokio
- tokio-tungstenite (WebSocket)
- JSON message protocol

**P2P Communication:**
- WebRTC for peer-to-peer voice connections
- SDP offer/answer exchange
- ICE candidate handling
- Real-time audio streaming

## Development

### Run Locally

```bash
# Option 1: Use default server (no setup needed)
npm run tauri dev

# Option 2: Self-host signaling server
# Terminal 1: Start signaling server
docker-compose up

# Terminal 2: Start Roommate app
npm run tauri dev
```

**Note:** The app connects to `signal.pkcollection.net` by default. You can change this in Settings → Connections.

### Build for Production

```bash
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

### Multi-Instance Development

For testing multiple accounts locally, use the provided batch files:

```bash
# Instance 1 (port 1420)
launch1.bat

# Instance 2 (port 1421)
launch2.bat
```

Each instance uses a separate data directory and port.

## Deployment

### Deploy Signaling Server to NAS/Server

See **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** for complete deployment instructions.

**Quick Options:**

1. **Dockge/Portainer (Recommended)** - See [deploy/DOCKGE_SETUP.md](deploy/DOCKGE_SETUP.md)
2. **One-Command Install**:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Pey-K/Roommate/main/deploy/install.sh | bash
   ```
3. **Manual Setup** - See [SIGNALING_SETUP.md](SIGNALING_SETUP.md)

## Roadmap

### ✅ Phase 1: Foundation (Complete)
- User identity (Ed25519)
- House creation and joining
- Room management
- Audio settings UI
- Voice activation & push-to-talk
- Device hot-swapping

### ✅ Phase 2: Signaling Infrastructure (Complete)
- WebSocket signaling server
- Connection health checks
- Status indicators & graceful degradation
- Docker deployment with GitHub Actions
- House invites and member management

### ✅ Phase 3: P2P Voice (Complete)
- WebRTC peer connections
- SDP offer/answer exchange
- ICE candidate handling
- Audio pipeline integration
- Voice activity detection
- Real-time presence tracking

### ✅ Phase 4: Enhanced Features (Complete)
- Multi-account support
- Account export/import
- Presence tracking (online, active, in call)
- Voice participant visibility
- Per-account signaling server configuration

### 📋 Phase 5: Future Enhancements (Planned)
- DHT mode (libp2p) for serverless peer discovery
- Text chat
- File sharing
- Mobile support
- Enhanced encryption features

## Contributing

Contributions are welcome! Please see **[CONTRIBUTING.md](CONTRIBUTING.md)** for guidelines on:
- Setting up your development environment
- Code style and conventions
- Submitting pull requests
- Testing requirements

## Security

Security is important to us. Please see **[SECURITY.md](SECURITY.md)** for:
- How to report security vulnerabilities
- Supported versions
- Security best practices

## License

This project is licensed under the MIT License - see the **[LICENSE](LICENSE)** file for details.

## Inspiration

Roommate aims to be the "best private alternative to Tox/Jami with modern usability" - focusing on small groups, privacy, and a smooth user experience similar to Discord but with true P2P architecture.
