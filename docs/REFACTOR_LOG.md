# Cordia Refactor Log

This log records the decision trail for ownership refactors. Update it after every phase so future work can see what changed, what was validated, and which compatibility boundaries remain.

## Phase 0 - State Ownership Guardrails

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added `docs/ARCHITECTURE_STATE_OWNERSHIP.md`.
- Added `docs/ATTACHMENT_GOLDEN_BEHAVIORS.md`.
- Defined identity, mutation, storage, and performance invariants.
- Runtime behavior unchanged.

### Validation

- Documentation-only phase.
- No runtime code refactored.
- No visual design changed.

### Notes

- `useEphemeralMessages()` remains the compatibility facade until consumers are migrated.
- Persisted fields and Tauri command signatures are unchanged.

## Phase 0.5 - Tiny Stress And Render Probe

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added a dev-only stress fixture/probe helper for manual before/after render observations.
- Runtime production behavior unchanged unless a developer explicitly imports and uses the helper in dev tooling.

### Validation

- `npm run build` passed.

### Notes

- The full heavy stress harness remains Phase 11.

## Phase 1 - Domain Type Extraction

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added domain type files under `src/domain/messages`, `src/domain/attachments`, `src/domain/content`, `src/domain/transfers`, and `src/domain/media`.
- Updated type-only imports for stores, chat attachment components, transfer center components, media preview consumers, waveform helpers, and preview builders.
- Kept compatibility type re-exports from `EphemeralMessagesContext` and `MediaPreviewContext`.
- Runtime behavior unchanged.

### Validation

- `npm run build` passed.

## Phase 2 - Attachment Presentation Builder

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added `src/features/chat/buildAttachmentPresentation.ts`.
- Introduced dimensional `AttachmentAvailability`.
- Routed the existing server attachment presentation helper through the pure builder.
- Wired `ServerMessageContent` attachment decisions through the builder without changing layout or card structure.

### Validation

- `npm run build` passed.

## Phase 3 - Transfer Normalization Bridge

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added keyed transfer indexes to `ephemeralMessagesStore`: `transfersByRequestId`, `activeDownloadIds`, `activeUploadIds`, `transferHistoryByRequestId`, and `historyIds`.
- Kept the existing `attachmentTransfers` and `transferHistory` arrays as compatibility surfaces.
- Updated transfer center selectors to use active ID lists/keyed transfer records.
- Added row-level transfer lookup hooks.
- Migrated `TransferCenterDownloadRow` to read live transfer updates by `request_id` while preserving existing props.

### Validation

- `npm run build` passed.

## Phase 4 - Transfer UI Throttling

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added explicit transfer UI throttle constants in `EphemeralMessagesContext`.
- Progress commits now use `TRANSFER_UI_UPDATE_MS` (250ms).
- Debug/speed/ETA/buffer commits and debug logging use `TRANSFER_DEBUG_UI_UPDATE_MS` (1000ms).
- Lifecycle updates such as start, complete, fail, reject, and cancel remain immediate.

### Validation

- `npm run build` passed.

## Phase 5 - ID-Oriented Chat And Preview Groundwork

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added `messagesById` indexing to `ephemeralMessagesStore`.
- Added `useMessageById(messageId)` for row-level message subscriptions.
- Updated `ServerMessageRow` to resolve the current message by ID while preserving existing `chatItems` input and layout.
- Added `MediaPreviewSession` state to `MediaPreviewContext` alongside the existing rich preview object.

### Validation

- `npm run build` passed.

## Phase 6 - Media Preview Session Wiring (Deferred)

Date: 2026-05-27
Status: **Deferred** (not skipped)

### Planned scope

- Open preview by reference IDs (`messageId`, `attachmentRefId`, gallery IDs).
- Modal resolves current facts from selectors instead of copying rich preview objects into modal state.

### Current state

- `MediaPreviewSession` type and state slot exist in `MediaPreviewContext`.
- All preview open paths still use rich `MediaPreviewState` objects.
- Incremental migration planned in post-bridge Phase 14 (image first, then video, then audio).

## Phase 7 - Content And Seed/Share Ownership

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added pure content availability/path selectors in `src/domain/content/selectors.ts`.
- Added seed/share domain types and selectors in `src/domain/sharing`.
- Routed `isSharedInServer` and `getServersForSha` through the seed/share selectors.
- Added `docs/PERSISTENCE_MIGRATION_NOTES.md`.

### Validation

- `npm run build` passed.

## Phase 8 - Full Chat Timeline ID Migration (Deferred)

Date: 2026-05-27
Status: **Deferred** (not skipped)

### Planned scope

- `<ServerChatTimeline chatId={chatId} />` with `<MessageRow messageId={id} />` and attachment cards by `attachmentRefId`.
- Remove broad transfer/history/callback prop bags from timeline rows.

### Current state

- `useMessageById` exists; timeline still receives grouped `chatItems` and global transfer arrays.
- Partial groundwork from Phase 5; full migration deferred until Phase 13.

## Phase 9 - Rust System Command Split

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Added `src-tauri/src/system_commands.rs`.
- Moved clipboard, open-in-file-explorer, and path existence Tauri commands out of `main.rs`.

### Validation

- `cargo check` passed from `src-tauri`.

## Phase 10 - Performance Profile (Superseded)

Date: 2026-05-13
Commit: not committed (working tree)
Superseded: Phase B (2026-05-27)

### What changed (historical)

- Added `performanceProfile` to `ThemeContext` with `quality`, `balanced`, and `low-end` options.
- Persisted the profile in localStorage as `cordia.performanceProfile`.
- Added a Performance Profile picker to Customize settings.
- Added low-end CSS overrides.

### Superseded by

- Phase B removes user-facing performance modes entirely.
- Phase 16 applies performance-friendly behavior as default Cordia behavior, not optional modes.

## Phase 11 - Stress Fixtures And Budgets

Date: 2026-05-13
Commit: not committed (working tree)

### What changed

- Expanded `src/lib/devStressFixture.ts` with configurable fixture sizes.
- Added `createHeavyDevStressFixture()`.
- Added `docs/PERFORMANCE_BUDGETS.md`.

### Validation

- `npm run build` passed.

---

## Phase A - Freeze And Validate

Date: 2026-05-27
Commit: not committed (working tree)

### What changed

- Updated all prior phase commit fields to `not committed (working tree)`.
- Added deferred entries for Phase 6 and Phase 8.
- Repo trust cleanup (no runtime refactors):
  - `LICENSE`: Roommate → Cordia Contributors
  - `deploy/install.sh`: compose URL → Pey-K/Cordia
  - `SECURITY.md`: GitHub private reporting; ephemeral messaging note updated
  - Removed stale `beacon-server/meta.json` (local Windows path artifact)
  - Removed root junk: `out.txt`, `refactor.cjs`, `refactor2.cjs`
  - Moved `launch1.bat`–`launch4.bat` to `dev-scripts/`
- Intentionally unchanged (backward compat): `rmmt:` localStorage keys, `ROOMMATE_DATA_DIR`, `.rmmt-cropper` CSS

### Golden behavior checklist (Phase A baseline)

Manual checklist from `docs/ATTACHMENT_GOLDEN_BEHAVIORS.md` — recorded at start of post-bridge work before Phases B–16. Items not individually exercised in CI; build + code review used as proxy until manual pass:

- Attachment send/receive/preview paths: **unchanged** (no runtime edits in Phase A)
- Transfer Center active rows: **unchanged**
- Seeding/share selectors: **unchanged**

Full manual golden pass required after Phase 12 Transfer Center migration.

### Render probe baseline (pre-Phase 12)

**Question:** When one transfer progresses, what rerenders?

**Method:** Static code-path analysis + subscription audit (dev `useRenderCount` probe recommended during Phase 12 validation).

| Component | Baseline (pre-Phase 12) | Expected after Phase 12 |
|-----------|-------------------------|-------------------------|
| `TransferCenterDownloadRow` | Yes — uses `useTransferByRequestId` | Yes (by `requestId`) |
| `TransferCenterActiveUploadStripRow` | Yes — receives changing `transfers[]` prop from panel | Yes (per `requestId`) |
| `TransferCenterPanel` | Yes — subscribes to full `attachmentTransfers`, rebuilds maps on every progress tick | Only on ID-list signature change |
| `ServerChatTimeline` | Likely yes — receives `attachmentTransfers` from `ServerViewPage` | No on progress tick |
| `ServerMessageContent` / attachment cards | Likely yes — parent props include transfer arrays | No on unrelated progress tick |

**Root cause:** `attachmentTransfers` array is canonical; keyed indexes exist but most UI still subscribes to the array.

### Validation

- `npm run build` passed (2026-05-27)
- `cargo check` passed from `src-tauri` (2026-05-27)

---

## Phase B - Remove Performance Modes Shell

Date: 2026-05-27
Commit: not committed (working tree)

### What changed

- Removed `performanceProfile`, `setPerformanceProfile`, and `PerformanceProfile` from `ThemeContext`.
- Removed Performance Profile picker from `CustomizeSettings`.
- Removed `[data-performance-profile="low-end"]` CSS rules from `index.css`.
- One-time cleanup removes legacy `cordia.performanceProfile` from localStorage on app load.
- Updated `docs/PERFORMANCE_BUDGETS.md` to describe default budgets (no mode toggles).
- Phase 10 marked superseded (see Phase 10 section above).

### Validation

- `npm run build` passed (2026-05-27)
- Transfer throttles and media behavior unchanged from pre-Phase-B

---

## Phase 12 - Keyed Transfer Source Of Truth

Date: 2026-05-27
Commit: not committed (working tree)

### What changed

- Added `upsertTransferByRequestId` / `removeTransferByRequestId` on `ephemeralMessagesStore` (single-writer; map is canonical, array derived).
- Added `src/domain/transfers/selectors.ts` and `src/features/transfers/viewModels.ts`.
- Migrated `EphemeralMessagesContext` transfer upserts to store keyed API.
- Migrated `TransferCenterPanel` off full `attachmentTransfers` subscription (uses ID signatures + row hooks).
- Migrated `TransferCenterActiveUploadStripRow` to `attachmentId` + `requestIds` with keyed subscriptions.
- Updated `TransferCenterButton` to use `activeDownloadIds`.

### Render probe (post-Phase 12, code-path)

- Transfer Center panel shell: should not rebuild maps on every progress tick (no `attachmentTransfers` subscription).
- Download/upload strip rows: subscribe by `requestId`.
- Chat timeline: still receives compat `attachmentTransfers` prop (Phase 13 debt).

### Validation

- `npm run build` passed (2026-05-27)

---

## Phase 13 - Selector-Driven Attachment Cards (partial)

Date: 2026-05-27
Commit: not committed (working tree)

### What changed

- Split `buildAttachmentPresentationFromFacts` from legacy array-input builder.
- Added `useAttachmentPresentation`, `useShareStatus`, `useLiveDownloadForAttachment` hooks.
- `ServerMessageContent.getAttachmentPresentation` uses keyed `resolveLiveDownloadForAttachment` instead of `.find()` on message transfer rows.

### Notes

- Full chat prop removal and per-card hook components remain for follow-up slices.

### Validation

- `npm run build` passed (2026-05-27)

---

## Phase 14 - Chat Image Preview Session (partial)

Date: 2026-05-27
Commit: not committed (working tree)

### What changed

- Added `MediaPreviewSessionBridge` to resolve chat image sessions from store facts.
- Chat image open path sets `MediaPreviewSession` + share-handler registry; video/audio still use rich `setMediaPreview`.

### Validation

- `npm run build` passed (2026-05-27)

---

## Phase 15 - Rust Move-Only Split (partial)

Date: 2026-05-27
Commit: not committed (working tree)

### What changed

- Added `src-tauri/src/attachments/hashing.rs` with SHA/piece hashing helpers moved from `main.rs`.

### Notes

- `downloads/` module and remaining attachment commands stay in `main.rs` for a follow-up move-only batch (tight coupling to session paths).

### Validation

- `cargo check` passed (2026-05-27)

---

## Phase 16 - Default Performance Hardening

Date: 2026-05-27
Commit: not committed (working tree)

### What changed

- Added `src/lib/performanceDefaults.ts` (transfer throttles, parallel caps, chat video preload default).
- Wired transfer constants from `performanceDefaults` in `EphemeralMessagesContext`.
- Chat inline video `preload` set to `none` via `CHAT_INLINE_VIDEO_PRELOAD`.
- Updated `docs/PERFORMANCE_BUDGETS.md` for single-path defaults (Phase B).

### Parallel caps

- Kept existing `MAX_PARALLEL_DOWNLOADS = 2` — no evidence yet to lower further.

### Validation

- `npm run build` passed (2026-05-27)
- `cargo check` passed (2026-05-27)
