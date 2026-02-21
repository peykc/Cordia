# Developer roadmap (technical)

This document is intentionally **developer-facing** (implementation-y notes, internal terminology, and sequencing).

The public, user-facing roadmap lives in `../README.md`.

## Completed foundations (historical)

These represent the core technical milestones Cordia has already shipped during development:

### ✅ Identity + local account storage
- Ed25519 identity stored locally
- Multi-account support (separate per-account data)
- Account export/import (`.key`)

### ✅ Servers + chats
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

### ✅ Phase 5 (v1 scope, completed)
- Ephemeral messaging (in-memory + optional persistent history; sync settings)
- Image/attachment approval (per-transfer confirm; ask vs always allow)
- Native audio pipeline v1 (cpal capture → frontend → WebRTC; mic UX, monitoring)

## In progress / planned (implementation notes)

### v1 (Windows release)
- Message sync on server open between users (request N messages from peers when opening a server)
- DM window (single OS window with tabs; DMs as 2-person server)
- NAT guidance (guided troubleshooting; detection + override already in place)
- Sound effects
- Frontend polish: downloads/uploads page, friends overview page, in-call/join call style

### v1.5
- macOS + Linux builds
- Screen sharing

### v2+
- Multi-channel servers gated behind hosting requirements
- Message persistence + history
- Audio pipeline v2 (Phase 2A/2B/2C: AudioWorklet, micro jitter buffer, Opus tuning)
- Optional relays for hard NAT cases
- Mobile

