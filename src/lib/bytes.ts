export function formatBytes(bytes: number | null | undefined): string {
  const b = Number(bytes)
  if (!Number.isFinite(b) || b < 0) return 'size ?'
  if (b < 1024) return `${Math.floor(b)} B`

  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = b / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  const asString = String(rounded).endsWith('.0') ? String(rounded).slice(0, -2) : String(rounded)
  return `${asString} ${units[unitIndex]}`
}

