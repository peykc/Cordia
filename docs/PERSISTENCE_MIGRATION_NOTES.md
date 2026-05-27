# Cordia Persistence Migration Notes

Cordia still uses localStorage for some growing state. Do not move this data until the state ownership split is stable, but future persistence should be designed around append-friendly files first.

## Candidate File Layout

```txt
app_data_dir/accounts/{accountId}/messages/{serverId}/{channelId}.jsonl
app_data_dir/accounts/{accountId}/content/index.snapshot.json
app_data_dir/accounts/{accountId}/transfers/history.jsonl
app_data_dir/accounts/{accountId}/shares/{serverId}.json
```

## Migration Rules

- Existing localStorage data must remain readable until a migration is implemented.
- No persisted field may be renamed without a migration note and fallback.
- Message history should prefer append events plus occasional compaction.
- Content index snapshots should be rebuildable from local cache and transfer/share records where possible.
- Accessibility scans should start with visible/recent rows and only scan all rows on explicit refresh or idle maintenance.

## Not Yet

SQLite is still a likely long-term fit, but JSONL/snapshots are the safer intermediate step while Cordia's state shape is still changing.
