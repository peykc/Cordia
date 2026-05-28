# Cordia Performance Budgets

Use these budgets during refactor smoke checks, especially with the dev stress fixtures in `src/lib/devStressFixture.ts`.

Cordia has one production behavior path — no user-facing performance modes. These defaults apply to everyone.

## Dev Fixtures

- Tiny baseline: `createDevStressFixture()` creates roughly 200 messages, 50 attachments, and 10 active-looking transfers.
- Heavy baseline: `createHeavyDevStressFixture()` creates roughly 1,000 messages, 400 attachments, and 20 active-looking transfers.

The fixtures are dev-only and return empty data in production builds.

## Budgets

- No full chat timeline rerender from one transfer progress tick.
- Transfer progress UI should update at most 4 times per second by default (~250ms throttle).
- Debug transfer metrics should update less often than progress (~1000ms or dev-only).
- No mounted video/audio elements outside visible or actively playing media.
- Opening a chat with 1,000 messages should avoid obvious main-thread stalls after initial data preparation.
- No large localStorage parse/stringify should happen during normal chat entry after storage migration work begins.
- No large binary/base64 blobs in React state.

## Manual Probe Notes

Use `useRenderCount()` on a temporary dev component or route when checking broad rerenders. Record before/after observations in `docs/REFACTOR_LOG.md`.

Suggested checks:

- Start a fake or real transfer and watch whether `ServerViewPage`, timeline rows, and attachment cards rerender on every tick.
- Open Transfer Center during active transfers and confirm only active rows visibly update.
