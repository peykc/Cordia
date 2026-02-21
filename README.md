# Cordia

A serious indie, privacy-first **P2P voice hangout app** with modern usability. Built with **Tauri + React + Rust**.

> **Project status**: In active development. **Cordia v1** will be the first downloadable **Windows `.exe`** on GitHub Releases.

## Table of contents

- [What is Cordia?](#what-is-cordia)
- [Download](#download)
- [Key features (today)](#key-features-today)
- [How it works](#how-it-works)
- [What Cordia is not](#what-cordia-is-not)
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
- **Servers + voice chats**: organize hangouts into servers and voice chats.
- **Presence**: see who’s online / active / in voice.
- **Accounts**: multiple local accounts on one device, each with its own data directory (passwordless key-based identity using **Ed25519**).
- **Backup/restore**: export/import your account to a `.key` file.
- **Optional Beacon**: improves discovery + presence and enables “multi-chat” servers when connected.

## How it works

- **Voice is always P2P**: media streams do **not** pass through the Beacon.
- **Beacon is optional**: it helps clients find each other and synchronize presence and server metadata.
- **Privacy model**:
  - Sensitive server state is encrypted client-side before it ever reaches the Beacon.
  - The Beacon still necessarily sees **some** routing metadata (e.g. user IDs, presence updates, server IDs) to do its job.

Cordia v1 servers behave like **single-channel group chats**. Multi-channel servers will come later, likely requiring a hosted server so the Beacon stays lightweight.

## What Cordia is not

Cordia will **not** require government ID or real names, will not offer public discovery (no user directory), and will not gate features by monetization. The Beacon does not inspect or retain message contents, and Cordia does not build or monetize social graphs. It is not designed for massive communities per server or per call. Full details: **[What Cordia is not](docs/DESIGN_BOUNDARIES.md)**.

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

### ✅ Completed (foundation milestones)

These are the major user-visible capabilities already built:

#### ✅ Phase 1 — Accounts + basic servers
- Create a local **account** (no passwords)
- Create/join **servers**
- Manage voice chats and basic server structure

#### ✅ Phase 2 — Beacon support (optional)
- Use the hosted **Beacon** or self-host your own
- Presence + “connected / offline” status
- Better discovery + richer server features when Beacon is connected

#### ✅ Phase 3 — P2P voice experience
- Peer-to-peer **voice calls** (WebRTC)
- Speaking indicators + voice presence

#### ✅ Phase 4 — Reliability + usability
- Multiple local accounts
- Backup/restore via `.key`
- Audio settings + device hot-swapping

#### ✅ Phase 5 — Messaging, media, and audio
- **Ephemeral messaging**: buffered while app is open; persistent/ephemeral storage options
- **Images/attachments**: approve per transfer, with "ask every time" vs "always allow" setting
- **Audio pipeline v1**: native capture (cpal), mic UX, monitoring/visualization, device hot-swap

### 📌 Next — Cordia v1 (Windows release)

- **Windows `.exe`** on GitHub Releases
- **Message sync on server open** between users (when you open a server, sync the most recent messages from other online users)
- **Friends → DMs**: one DM experience with tabs (DMs behave like a 2-person server)
- **NAT guidance**: detect Open/Moderate/Strict and guide users to fixes (no relay); detection and override already exist
- **Sound effects**: configurable UX sounds (e.g. join/leave, pings)
- **UI polish**: downloads/uploads page, friends overview page, in-call/join call style

### 🔜 After v1 — Cordia v1.5

- **macOS + Linux builds**
- **Screen sharing**

### 🔮 After launch — Cordia v2

- **Multi-channel servers** (when hosting is introduced)
- **Message persistence** (history across app restarts)
- **Audio pipeline v2**: Phase 2 improvements (e.g. AudioWorklet decoupling, micro jitter buffer, receiver-side Opus tuning) per [docs/NATIVE_AUDIO_PIPELINE_PLAN.md](docs/NATIVE_AUDIO_PIPELINE_PLAN.md)
- **Optional relays** for difficult NAT cases (voice stays P2P when possible)
- **Mobile support**

## Contributing

Contributions are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Security

See **[SECURITY.md](SECURITY.md)** for reporting and supported versions.

## License

MIT. See **[LICENSE](LICENSE)**.
