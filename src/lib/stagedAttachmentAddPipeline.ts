import type { Dispatch, SetStateAction } from 'react'
import type { StagedAttachment } from '../components/server/ServerComposer'
import { getFileMetadata, getAttachmentRecord, registerAttachmentFromPath } from './tauri'

const METADATA_BATCH = 10
const DRAFT_UI_BATCH = 10

/** Poll until the attachment index reports full prep (SHA, pieces, waveform/thumb). */
export async function waitForAttachmentRecordReady(
  attachmentId: string,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<Awaited<ReturnType<typeof getAttachmentRecord>>> {
  const timeoutMs = opts?.timeoutMs ?? 120_000
  const intervalMs = opts?.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rec = await getAttachmentRecord(attachmentId)
    if (rec?.status === 'ready' && rec.sha256) return rec
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return getAttachmentRecord(attachmentId)
}

async function mapInBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize)
    const part = await Promise.all(chunk.map(fn))
    out.push(...part)
  }
  return out
}

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function appendDraftRowsInBatches(
  setStagedAttachments: Dispatch<SetStateAction<StagedAttachment[]>>,
  rows: StagedAttachment[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += DRAFT_UI_BATCH) {
    if (i > 0) await raf()
    const chunk = rows.slice(i, i + DRAFT_UI_BATCH)
    setStagedAttachments((prev) => [...prev, ...chunk])
  }
}

/**
 * Serialize multiple “add many files” runs so only one attachment is in native prep at a time.
 * Avoids overlapping FFmpeg/SHA work and keeps ordering predictable.
 */
let registrationChain: Promise<void> = Promise.resolve()

/**
 * Stage 1: fetch file metadata in parallel batches, append draft chips in UI batches (rAF between).
 * Stage 2: `register_attachment_from_path` + wait for `ready` for each file, strictly one after another.
 *
 * We do not skip registration based on parent refs: after stage 1, React may not have committed yet, so a
 * ref mirroring `stagedAttachments` would falsely report new rows as “removed” and skip every file. Updates
 * no-op when the user removed a row (`findIndex` < 0). Rare case: removing a chip before its turn may
 * still complete native registration for that path.
 */
export async function enqueueStagedAttachmentAdd(
  paths: string[],
  storageMode: 'current_path' | 'program_copy',
  setStagedAttachments: Dispatch<SetStateAction<StagedAttachment[]>>
): Promise<void> {
  const job = async () => {
    if (paths.length === 0) return

    const pathMetas = await mapInBatches(paths, METADATA_BATCH, async (path) => {
      const meta = await getFileMetadata(path)
      return { path, meta }
    })

    const baseTs = Date.now()
    const newRows: StagedAttachment[] = pathMetas.map(({ path, meta }, i) => ({
      staged_id: `${path}:${baseTs}:${i}:${Math.random().toString(36).slice(2)}`,
      path,
      file_name: meta.file_name,
      extension: meta.extension,
      size_bytes: meta.size_bytes,
      storage_mode: storageMode,
      spoiler: false,
      ready: false,
    }))

    await appendDraftRowsInBatches(setStagedAttachments, newRows)

    for (const draftRow of newRows) {
      try {
        const result = await registerAttachmentFromPath(draftRow.path, storageMode)
        const attachment_id = result.attachment_id

        setStagedAttachments((prev) => {
          const idx = prev.findIndex((a) => a.staged_id === draftRow.staged_id)
          if (idx < 0) return prev
          const next = [...prev]
          next[idx] = {
            ...next[idx],
            attachment_id,
            ready: false,
            thumbnail_path: null,
            preparePercent: undefined,
          }
          return next
        })

        await waitForAttachmentRecordReady(attachment_id)
        const rec = await getAttachmentRecord(attachment_id)

        setStagedAttachments((prev) => {
          const idx = prev.findIndex((a) => a.staged_id === draftRow.staged_id)
          if (idx < 0) return prev
          const next = [...prev]
          next[idx] = {
            ...next[idx],
            ready: Boolean(rec?.status === 'ready' && rec.sha256),
            thumbnail_path: rec?.thumbnail_path ?? null,
          }
          return next
        })
      } catch (e) {
        console.warn('Staged attachment registration failed:', draftRow.path, e)
        setStagedAttachments((prev) => {
          const idx = prev.findIndex((a) => a.staged_id === draftRow.staged_id)
          if (idx < 0) return prev
          const next = [...prev]
          next[idx] = {
            ...next[idx],
            ready: false,
            prepareError: e instanceof Error ? e.message : 'Failed to prepare',
          }
          return next
        })
      }
    }
  }

  const thisRun = registrationChain.then(job)
  registrationChain = thisRun.catch((err) => {
    console.warn('Staged attachment pipeline error:', err)
  })
  await thisRun
}
