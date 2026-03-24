/**
 * Thumbnail path tiering aligned with chat single-image attachments (720px tier).
 * Reduces decode cost when scrolling long transfer / seeding lists.
 *
 * Video thumbs on disk are `{uuid}.jpg` (see Rust `extract_thumbnail`). Image thumbs use
 * `{uuid}_720.jpg` etc. Only rewrite paths that already use a tier suffix — otherwise we
 * would incorrectly map `uuid.jpg` → `uuid_720.jpg` (missing file, broken previews).
 */
export function listImageTierThumbnailPath(
  thumbPath: string | undefined,
  hasPath?: string | undefined
): string | undefined {
  if (!thumbPath) return hasPath
  const target = 720
  const hadTierSuffix = /_(720|576|480)\.jpg$/i.test(thumbPath)
  if (!hadTierSuffix) {
    return thumbPath
  }
  const base = thumbPath.replace(/_(720|576|480)\.jpg$/i, '.jpg')
  const tiered = base.replace(/\.jpg$/i, `_${target}.jpg`)
  return tiered || thumbPath
}
