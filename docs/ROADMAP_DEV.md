# Developer roadmap (technical)

This document is intentionally **developer-facing** (implementation-y notes, internal terminology, and sequencing).

The public, user-facing roadmap lives in `../README.md`.

## Completed foundations (historical)

These represent the core technical milestones Cordia has already shipped during development:

### ✅ Identity + local account storage
- Ed25519 identity stored locally
- Multi-account support (separate per-account data)
- Account export/import (`.key`)

### ✅ Servers (“Houses”) + chats
- Create/join servers via invite codes
- Local encrypted server state
- Multi-chat model when Beacon is connected

### ✅ Beacon infrastructure
- Beacon server with WebSocket + HTTP (Axum)
- Presence + profile metadata sync
- Rate limiting / basic abuse protections
- Container deployment + GHCR publishing

### ✅ P2P voice
- WebRTC peer connections
- ICE candidate exchange
- Voice presence + speaking indicators

## In progress / planned (implementation notes)

### v1 (Windows release)
- DM window (single OS window with tabs)
- Ephemeral messaging (buffered while app is open)
- Audio pipeline improvements (mic UX + monitoring; reduce web permission friction)
- NAT detection + guided troubleshooting (Open / Moderate / Strict; no relay)
- Sound effects
- Frontend polish (server view, DM window, settings)

### v1.5
- macOS + Linux builds
- Screen sharing

### v2+
- Multi-channel servers gated behind hosting requirements
- Message persistence + history
- Optional relays for hard NAT cases
- Mobile

