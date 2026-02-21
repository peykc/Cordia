# Testing

This document describes how to run tests and what to verify before release. For v1, Cordia relies on **manual testing** plus **Rust unit tests** where they exist.

## Automated tests

### Rust (backend)

The Tauri backend has unit tests in Rust. Run them from the project root:

```bash
cd src-tauri
cargo test
```

Or from the repo root:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Current coverage includes at least:

- **Account manager**: session lifecycle (create account, set/clear session, logout).

Add new tests in the same crate under `#[cfg(test)]` modules as you touch backend code.

### Frontend

There is **no** frontend test framework (Jest, Vitest, Playwright, etc.) for v1. UI and WebRTC flows are validated manually. Adding E2E or component tests is planned for after v1.

### Beacon stress test (optional)

To load-test a Beacon server (e.g. before a release or when tuning capacity):

```bash
npm run stress-test
# Or with explicit URL and connection count:
node stress-test.mjs wss://your-beacon.example.com 500
```

Requires the `ws` dependency (already in the project). This does **not** test the Cordia app itself—only the Beacon WebSocket server.

---

## Manual testing

Before shipping v1 (or a release branch), run through the following on a clean profile and with two instances where noted.

### Prerequisites

- Two Cordia instances (e.g. `npm run tauri dev` in two terminals, or use `launch1.bat` / `launch2.bat` on Windows).
- Beacon reachable (default hosted Beacon or local Docker). See [QUICKSTART.md](../QUICKSTART.md) and [BEACON_SETUP.md](../BEACON_SETUP.md).

### Smoke checklist (v1)

Use this as a minimum pass before release. Tick off each item; note any failures for follow-up.

#### Accounts and identity

- [ ] Create a new account (no password).
- [ ] Log out and log back in; session and profile persist.
- [ ] Switch between multiple local accounts; data is isolated.
- [ ] Export account to `.key` file; import on another instance or after reinstall; identity and servers restore.

#### Beacon and presence

- [ ] App shows “Connected” when Beacon is reachable.
- [ ] Presence updates: other user’s online/active/in-call state appears within a few seconds.
- [ ] After disconnecting Beacon (or blocking it), app shows disconnected; reconnecting restores presence.

#### Servers and chats

- [ ] Create a server; add a chat; see server and chat in the list.
- [ ] Generate invite; second user redeems invite and joins server; both see the same server and members.
- [ ] Open server and chat; send a text message; other user sees it (ephemeral messaging).
- [ ] Send an image/attachment; other user gets prompt (ask/allow); transfer completes and displays.

#### Voice

- [ ] User A joins voice in a server; User B sees A in the voice section and can join.
- [ ] Both in call: A hears B, B hears A; no one else in the server hears them.
- [ ] Speaking indicator (e.g. ring/border) updates when either speaks.
- [ ] Per-user volume/mute (right-click in call): change volume and “Mute (local)”; only local playback changes; leave and rejoin; prefs (e.g. mute) persist for that remote user.
- [ ] Leave call; rejoin; connection and audio work again.
- [ ] Audio settings: change input/output device; level meter and mic test respond; in-call audio still works (or hot-swap behaves as documented).

#### Settings and UI

- [ ] Settings open; Account, Audio, Connection, Messages, Downloads, etc. load without error.
- [ ] Connection: Beacon URL save and “Check” work; NAT indicator (if shown) updates.
- [ ] Audio: device list, input level, mic test, VAD/gain settings apply.
- [ ] Messages: persistence mode and “max messages to sync” save and are used.
- [ ] Downloads: preferred directory and attachment approval (ask/always) apply to next transfer.

#### Edge cases and recovery

- [ ] One user disconnects from Beacon briefly; other user’s presence updates; reconnecting restores.
- [ ] During a call, one user’s network glitches (e.g. disable Wi‑Fi for a few seconds); ICE recovery (disconnect → checking → connected or renegotiation) runs; audio resumes or fails gracefully (no permanent hang).
- [ ] Close and reopen app; re-login; servers and chats load; can rejoin voice.

### Before release (bundle)

- [ ] Run `npm run tauri build` (or your release build command); build completes.
- [ ] Install the built `.exe` (or run the installer); app starts and shows correct icon and title.
- [ ] Run smoke checklist again against the built app (not just dev).

---

## What we don’t test yet (v1)

- **No automated E2E**: no Playwright/Cypress; all UI flows are manual.
- **No frontend unit tests**: no Jest/Vitest for React components or libs.
- **No automated WebRTC tests**: no synthetic “two peers in a script” voice test; voice is manual only.
- **No regression suite**: no fixed set of automated tests run on every commit; CI may run only `cargo test` and `npm run build` if configured.

These are candidates for post–v1 (e.g. v1.5 or v2) as the codebase and release process mature.

---

## Adding tests later

- **Rust**: add `#[test]` functions and `#[cfg(test)]` modules in the same crate; run with `cargo test`.
- **Frontend**: introduce a test runner (e.g. Vitest) and add unit tests for utilities and pure logic first; E2E (e.g. Playwright) can follow for critical user journeys.
- **CI**: wire `cargo test` and `npm run build` (and later `npm test`) into GitHub Actions or your CI so main stays green.

If you add a test framework or CI config, update this doc and [CONTRIBUTING.md](../CONTRIBUTING.md) so contributors know how to run and extend tests.
