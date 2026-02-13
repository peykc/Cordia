export function truncateFileNameKeepExt(name: string, maxLen: number): string {
  const raw = (name ?? '').trim()
  if (!raw) return raw
  if (raw.length <= maxLen) return raw

  const lastDot = raw.lastIndexOf('.')
  const hasExt = lastDot > 0 && lastDot < raw.length - 1
  if (!hasExt) {
    // Fallback: simple ellipsis near end.
    const keep = Math.max(4, maxLen - 3)
    return raw.slice(0, keep) + '...'
  }

  const ext = raw.slice(lastDot) // includes "."
  const base = raw.slice(0, lastDot)

  // If extension itself is long or maxLen is tiny, fall back.
  if (ext.length >= maxLen - 4) {
    const keep = Math.max(4, maxLen - 3)
    return raw.slice(0, keep) + '...'
  }

  const keepBase = Math.max(4, maxLen - ext.length - 3)
  return base.slice(0, keepBase) + '...' + ext
}

