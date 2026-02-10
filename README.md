# Cordia

A serious indie, privacy-first **P2P voice hangout app** with modern usability. Built with **Tauri + React + Rust**.

> **Project status**: In active development. **Cordia v1** will be the first downloadable **Windows `.exe`** on GitHub Releases.

## Table of contents

- [What is Cordia?](#what-is-cordia)
- [Download](#download)
- [Key features (today)](#key-features-today)
- [How it works](#how-it-works)
- [Self-hosting (optional)](#self-hosting-optional)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What is Cordia?

Cordia is for small groups who want a Discord-like “home” for hanging out, but with **voice that connects directly peer-to-peer**.

You can use Cordia with a default hosted **Beacon**, or self-host your own to go “off grid”.

## Download

- **Windows (v1)**: GitHub Releases (coming soon)
- **macOS + Linux (v1.5)**: planned after v1

If you’re building from source, start with **[QUICKSTART.md](QUICKSTART.md)**.

## Key features (today)

- **P2P voice**: low-latency peer-to-peer voice calls (WebRTC).
- **Servers (“Houses”) + voice chats**: organize hangouts into servers and voice chats.
- **Presence**: see who’s online / active / in voice.
- **Accounts**: multiple local accounts on one device, each with its own data directory.
- **Backup/restore**: export/import your account to a `.key` file.
- **Optional Beacon**: improves discovery + presence and enables “multi-chat” servers when connected.

## How it works

- **Voice is always P2P**: media streams do **not** pass through the Beacon.
- **Beacon is optional**: it helps clients find each other and synchronize presence and server metadata.
- **Privacy model**:
  - Sensitive server state is encrypted client-side before it ever reaches the Beacon.
  - The Beacon still necessarily sees **some** routing metadata (e.g. user IDs, presence updates, server IDs) to do its job.

When the Beacon is unavailable, Cordia can fall back to limited functionality (for example, one default chat per server).

## Self-hosting (optional)

Cordia ships with a default Beacon at `beacon.pkcollection.net`, but you can self-host your own:

- **Local / Docker**: **[BEACON_SETUP.md](BEACON_SETUP.md)**
- **NAS / server deployment**: **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)**
- **Dockge/Portainer**: **[deploy/DOCKGE_SETUP.md](deploy/DOCKGE_SETUP.md)**

## Documentation

If you’re new, start here:

- **[Quick Start](QUICKSTART.md)**: run the app + connect to a Beacon
- **[Windows dev setup](SETUP.md)**: toolchain setup for building on Windows

Self-hosting:

- **[Beacon setup](BEACON_SETUP.md)**: run your own Beacon (Docker or Rust)
- **[Deployment guide](DEPLOYMENT_GUIDE.md)**: deploy Beacon to NAS/server
- **[GitHub Actions image builds](GITHUB_SETUP.md)**: build/push Beacon images to GHCR

More internal/dev planning docs live in **[`docs/`](docs/)**.

## Roadmap

This roadmap is written as **user-facing outcomes**. A more technical “developer roadmap” lives in **[`docs/ROADMAP_DEV.md`](docs/ROADMAP_DEV.md)**.

### Phase 1 — Cordia v1 (Windows release)

- **Windows `.exe` download on GitHub Releases**
- **Friends → DMs**: 1 DM window with tabs (DMs behave like a 2-person server)
- **Ephemeral messaging**: messages exist while the app is open (no persistence yet)
- **Images**: approved per-image (with optional “trust this friend for images” prompt after download)
- **Audio pipeline v1**: better mic UX + monitoring/visualization (beyond browser defaults)
- **NAT guidance**: detect Open/Moderate/Strict and guide users to fixes (no relay)
- **Sound effects**: basic UX sounds (join/leave/pings) and configurable volumes
- **UI polish**: server view, DM window, settings

### Phase 2 — Cordia v1.5 (after v1)

- **macOS + Linux builds**
- **Screen sharing**
- More UX polish and quality-of-life improvements

### Phase 3 — Cordia v2 (after launch)

- **Multi-channel servers** (hosted “House” requirement)
- **Message persistence** (history across app restarts)
- **Optional relays** for difficult NAT cases (voice still P2P when possible)
- **Mobile support**

## Contributing

Contributions are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Security

See **[SECURITY.md](SECURITY.md)** for reporting and supported versions.

## License

MIT. See **[LICENSE](LICENSE)**.
