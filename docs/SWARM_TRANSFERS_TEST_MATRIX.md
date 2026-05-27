# Swarm Transfers V1 Test Matrix

Feature flag: `swarmTransfersV1` (local override via `localStorage['cordia:feature:swarmTransfersV1'] = 'true'`).

## Core Scenarios

- Single seeder, single downloader:
  - file reaches 100%, SHA validated, saved path populated
  - downloader can click `Seed in this server` and become available
- Multi seeder swarm:
  - peer list ranks higher quality peers first
  - downloader can switch source peer when a peer goes offline
- Churn:
  - disconnect seeder mid-transfer; downloader recovers with another peer
  - reconnect seeder and verify tracker presence recovers

## Resume + Integrity

- Pause/resume in-session:
  - queued/paused transfer resumes without restarting bytes already written
- Restart resume:
  - resume state survives app restart and continues from partial `.part`
- Hash mismatch:
  - invalid piece/file hash marks transfer as failed and does not finalize output

## Stress / Reliability

- Peer disconnect storm:
  - many rapid connect/disconnect events do not crash client/beacon
- Concurrent downloads:
  - active cap respected; queued downloads start in order when slots free
- Seeder load:
  - upload throughput and leecher counts visible in transfer center

## Rollout Steps

1. Ship behind `swarmTransfersV1` default-off.
2. Enable for internal/dev accounts.
3. Observe telemetry and logs for peer-list quality, reconnect rates, and hash failures.
4. Enable by default after soak period with fallback path still available.
5. Remove legacy single-uploader request/response flow once parity is confirmed.
