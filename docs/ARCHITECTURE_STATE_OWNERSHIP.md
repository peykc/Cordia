# Cordia State Ownership

Cordia is a private group space with chat, media, transfers, voice, and local file ownership. The code should be organized by which layer owns a truth, not by which folder looks tidy.

The guiding sentence:

> Messages describe what happened. Attachment refs describe what was attached. Content records describe which byte-identical file exists. Transfers describe byte movement. Media preview describes what the user is currently viewing. Seed/share records describe server exposure.

## Identity Boundaries

### Message

A message identifies a chat event.

It owns:

- Message ID.
- Server and chat identity.
- Author.
- Sent timestamp.
- Text/caption.
- Message-local attachment ref IDs.
- Delivery status.

It must not own:

- Transfer progress.
- Playback progress.
- Preview modal state.
- Upload subscribers.
- Waveform playback state.

### Attachment Reference

An attachment ref identifies one message-local file reference.

It owns:

- Attachment ID.
- Message ID.
- Message-local order.
- Original file name.
- Declared file size.
- Spoiler flag.
- Sender-provided metadata.
- Optional SHA-256 once known.

It must not be the global file identity. The same content can appear in multiple messages.

### Content

Content identifies exact byte-for-byte file identity, usually by SHA-256.

It owns:

- Content ID / SHA-256.
- Canonical local path when available.
- Cached paths.
- Thumbnail paths.
- Waveform data.
- Media kind.
- File size.
- Local availability.

Content is the right layer for dedupe, cache reuse, seeding, and cross-server same-file behavior.

### Transfer

A transfer identifies one attempt to move bytes.

It owns:

- Request ID.
- Direction.
- Peer.
- Status.
- Progress.
- Speed.
- ETA.
- Error.
- Resume state.
- Temporary stream state.

A transfer is not a file. It is an event involving a file.

### Media Preview

Media preview identifies temporary UI viewing or playback state.

It owns:

- Preview session identity.
- Current selected attachment/content.
- Gallery scope.
- Playback or viewing UI state.
- Zoom/fullscreen/controls state.

Preview state must not become content metadata or transfer state.

### Seed/Share

A seed/share record identifies where content is exposed.

It owns:

- Server signing public key.
- Content ID / SHA-256.
- Shared timestamp.
- Derived server list for a piece of content.

It answers whether content is shared in a server, not whether a message was delivered.

## Mutation Invariants

- Transfer progress must never mutate a message.
- Playback state must never mutate an attachment.
- Preview state must never mutate content metadata.
- Thumbnail generation must never block chat rendering.
- A missing local file must not delete message history.
- A failed transfer must not imply the content is gone forever.
- Presence and transfer updates must not wake unrelated chat/media UI.

## Storage Invariants

- React state should hold IDs, paths, and small metadata.
- React state should not hold large blobs, full files, large base64 strings, decoded audio buffers, video frames, or binary chunks.
- LocalStorage is acceptable for small settings, but not for unbounded chat/media/transfer history.
- Blob URLs must be revoked by the code that creates them.
- Content availability should be derived from content/path/share/transfer truth, not guessed inside UI components.
- Persisted fields must not be renamed without an explicit migration.

## Performance Invariants

- Transfer protocol events may happen at full speed; React UI progress must be throttled.
- Start, complete, fail, reject, and file-available events can update immediately.
- Progress, speed, ETA, debug buffered bytes, and pending bytes should be batched.
- Large list components should subscribe to IDs and row-level state, not broad arrays.
- Chat timeline rendering should be driven by message arrival and visible row state, not every transfer tick.
- Media elements should mount only when visible or actively playing.

## Examples

### Transfer Progress

Bad:

```ts
message.attachments[0].progress = progress
```

Good:

```ts
transferStore.byRequestId[requestId] = {
  ...transferStore.byRequestId[requestId],
  progress,
}
```

The attachment card derives progress through a selector.

### Preview State

Bad:

```ts
attachment.previewIsOpen = true
attachment.currentTime = 42
```

Good:

```ts
mediaPreviewStore.open({
  source: 'chat',
  messageId,
  attachmentRefId,
})
```

The modal resolves attachment and content data from selectors.

### Same File In Multiple Messages

Bad:

```txt
Message A owns file X.
Message B stores a duplicate copy of file X.
```

Good:

```txt
Message A -> AttachmentRef A -> Content SHA X
Message B -> AttachmentRef B -> Content SHA X
```

The content library owns file availability and cache paths for SHA X.
