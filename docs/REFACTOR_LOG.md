# Cordia Refactor Log

This log records the decision trail for ownership refactors. Update it after every phase so future work can see what changed, what was validated, and which compatibility boundaries remain.

## Phase 0 - State Ownership Guardrails

Date: 2026-05-13
Commit: pending

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
Commit: pending

### What changed

- Added a dev-only stress fixture/probe helper for manual before/after render observations.
- Runtime production behavior unchanged unless a developer explicitly imports and uses the helper in dev tooling.

### Baseline Notes

- Baseline measurements still need to be captured manually before Phase 3 transfer normalization.
- The primary question is whether transfer progress wakes chat timeline or attachment rows unnecessarily.

### Validation

- `npm run build` passed.

### Notes

- The full heavy stress harness remains Phase 11.

## Phase 1 - Domain Type Extraction

Date: 2026-05-13
Commit: pending

### What changed

- Added domain type files under `src/domain/messages`, `src/domain/attachments`, `src/domain/content`, `src/domain/transfers`, and `src/domain/media`.
- Updated type-only imports for stores, chat attachment components, transfer center components, media preview consumers, waveform helpers, and preview builders.
- Kept compatibility type re-exports from `EphemeralMessagesContext` and `MediaPreviewContext`.
- Runtime behavior unchanged.

### Validation

- `npm run build` passed.

### Notes

- No fields were renamed.
- No persisted data shapes changed.
- No runtime logic was moved.

## Phase 2 - Attachment Presentation Builder

Date: 2026-05-13
Commit: pending

### What changed

- Added `src/features/chat/buildAttachmentPresentation.ts`.
- Introduced dimensional `AttachmentAvailability`.
- Routed the existing server attachment presentation helper through the pure builder.
- Wired `ServerMessageContent` attachment decisions through the builder without changing layout or card structure.

### Validation

- `npm run build` passed.

### Notes

- No visual design changes were made.
- No attachment state or action was removed.
- The builder keeps compatibility fields such as `hasPath`, `notDownloaded`, `liveDownload`, and `downloadProgress` for existing render paths.

## Phase 3 - Transfer Normalization Bridge

Date: 2026-05-13
Commit: pending

### What changed

- Added keyed transfer indexes to `ephemeralMessagesStore`: `transfersByRequestId`, `activeDownloadIds`, `activeUploadIds`, `transferHistoryByRequestId`, and `historyIds`.
- Kept the existing `attachmentTransfers` and `transferHistory` arrays as compatibility surfaces.
- Updated transfer center selectors to use active ID lists/keyed transfer records.
- Added row-level transfer lookup hooks.
- Migrated `TransferCenterDownloadRow` to read live transfer updates by `request_id` while preserving existing props.

### Validation

- `npm run build` passed.

### Notes

- Existing transfer consumers still receive the old arrays.
- This is a compatibility bridge, not the final transfer-store shape.
- No persisted fields changed.

## Phase 4 - Transfer UI Throttling

Date: 2026-05-13
Commit: pending

### What changed

- Added explicit transfer UI throttle constants in `EphemeralMessagesContext`.
- Progress commits now use `TRANSFER_UI_UPDATE_MS`.
- Debug/speed/ETA/buffer commits and debug logging use `TRANSFER_DEBUG_UI_UPDATE_MS`.
- Lifecycle updates such as start, complete, fail, reject, and cancel remain immediate through existing status upserts.

### Validation

- `npm run build` passed.

### Notes

- Default progress UI throttle is `250ms`.
- Debug metrics remain throttled separately at `1000ms`.
- Render baseline still needs manual observation with the dev stress probe.

## Phase 5 - ID-Oriented Chat And Preview Groundwork

Date: 2026-05-13
Commit: pending

### What changed

- Added `messagesById` indexing to `ephemeralMessagesStore`.
- Added `useMessageById(messageId)` for row-level message subscriptions.
- Updated `ServerMessageRow` to resolve the current message by ID while preserving existing `chatItems` input and layout.
- Added `MediaPreviewSession` state to `MediaPreviewContext` alongside the existing rich preview object.

### Validation

- `npm run build` passed.

### Notes

- Chat UI design and layout were not changed.
- The timeline still accepts existing grouped chat items; this phase only adds a narrow ID-based path.
- Media preview behavior remains unchanged until session-based open/resolve is wired in a later focused pass.

## Phase 7 - Content And Seed/Share Ownership

Date: 2026-05-13
Commit: pending

### What changed

- Added pure content availability/path selectors in `src/domain/content/selectors.ts`.
- Added seed/share domain types and selectors in `src/domain/sharing`.
- Routed `isSharedInServer` and `getServersForSha` through the seed/share selectors.
- Added `docs/PERSISTENCE_MIGRATION_NOTES.md` with the JSONL/snapshot migration target.

### Validation

- `npm run build` passed.

### Notes

- Existing localStorage data remains unchanged.
- No persisted field names were changed.
- SQLite remains deferred until the data shape stabilizes.

## Phase 9 - Rust System Command Split

Date: 2026-05-13
Commit: pending

### What changed

- Added `src-tauri/src/system_commands.rs`.
- Moved clipboard, open-in-file-explorer, and path existence Tauri commands out of `main.rs`.
- Kept command names and signatures unchanged.
- Left frontend invocation code unchanged.

### Validation

- `cargo check` passed from `src-tauri`.

### Notes

- This was a move-only Rust batch.
- Attachment/download/server command logic remains in `main.rs` for later move-only passes.

## Phase 10 - Performance Profile

Date: 2026-05-13
Commit: pending

### What changed

- Added `performanceProfile` to `ThemeContext` with `quality`, `balanced`, and `low-end` options.
- Persisted the profile in localStorage as `cordia.performanceProfile`.
- Added a Performance Profile picker to Customize settings.
- Added low-end CSS overrides that disable backdrop blur, shimmer/fade/toast animations, heavy shadows, and long transitions.

### Validation

- `npm run build` passed.

### Notes

- Quality mode preserves existing visuals.
- Low-end mode currently reduces visual effects; transfer/media behavioral tuning can now read the profile in later focused passes.

## Phase 11 - Stress Fixtures And Budgets

Date: 2026-05-13
Commit: pending

### What changed

- Expanded `src/lib/devStressFixture.ts` with configurable fixture sizes.
- Added `createHeavyDevStressFixture()` for a 1,000-message baseline with hundreds of attachments and active-looking transfers.
- Added `docs/PERFORMANCE_BUDGETS.md`.

### Validation

- `npm run build` passed.

### Notes

- The fixture is dev-only and returns empty data in production builds.
- Manual render observations still need to be captured while exercising the app.
