# Cordia Attachment Golden Behaviors

Use this checklist after each refactor phase that touches messages, attachments, content, transfers, media preview, or seeding. Build passing is not enough; these behaviors are user-visible.

## Images

- [ ] Sent image appears in chat.
- [ ] Received image appears in chat.
- [ ] Clicking an available image opens media preview.
- [ ] Grouped image gallery navigation works.
- [ ] Thumbnail fallback renders when no thumbnail is available.
- [ ] Missing local file does not delete or hide message history.

## Videos

- [ ] Video thumbnail/card appears in chat.
- [ ] Clicking an available video opens video preview.
- [ ] Playback controls work.
- [ ] Gallery strip works for grouped media.
- [ ] Closing the modal releases preview playback/object URL ownership.
- [ ] Unavailable video keeps a clear unavailable/download state.

## Audio

- [ ] Audio attachment renders with file metadata.
- [ ] Waveform/progress renders when waveform data exists.
- [ ] Missing waveform data falls back gracefully.
- [ ] Play/pause works.
- [ ] Album art fallback works.
- [ ] Modal audio player still works.
- [ ] Opening modal playback does not leave conflicting inline playback running.

## Generic Files

- [ ] File card renders.
- [ ] Download works.
- [ ] Open folder/location works after download.
- [ ] Unavailable file shows the correct state.
- [ ] Failed/rejected transfer state remains visible and understandable.

## Transfers

- [ ] Active download appears in Transfer Center.
- [ ] Active upload appears in Transfer Center.
- [ ] Progress updates without requiring a whole chat timeline rerender.
- [ ] Cancel works.
- [ ] Failed/rejected state renders.
- [ ] Completed file moves to history.
- [ ] Completed downloaded attachment can be previewed or opened from the saved path.

## Seeding And Share

- [ ] Same SHA shared twice does not duplicate incorrectly in the seeding library.
- [ ] Seeding library row opens the correct file/location.
- [ ] Shared-here state remains correct for the current server.
- [ ] Shared-elsewhere state remains correct across other servers.
- [ ] Removing a share restores the appropriate share affordance where expected.
- [ ] Download once, reuse from cache works across repeated same-SHA messages.

## Regression Notes

When a checklist item changes, record it in `docs/REFACTOR_LOG.md` as either:

- Intentional bug fix.
- Expected temporary limitation.
- Regression that blocks the phase.
