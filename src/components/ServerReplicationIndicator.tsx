import { memo } from 'react'
import { cn } from '../lib/utils'

const MAX_DOTS = 8

/** Compact visual for “how many servers this file is shared on”; full names in tooltip. */
export const ServerReplicationIndicator = memo(function ServerReplicationIndicator({
  count,
  serverNames,
  className,
}: {
  count: number
  serverNames?: string[]
  className?: string
}) {
  const title =
    serverNames && serverNames.length > 0
      ? serverNames.join('\n')
      : count === 0
        ? 'Not shared on any server'
        : `${count} server${count !== 1 ? 's' : ''}`

  if (count <= 0) {
    return (
      <span
        className={cn('inline-flex shrink-0 text-[9px] tabular-nums text-muted-foreground/70', className)}
        title={title}
      >
        —
      </span>
    )
  }

  const dots = Math.min(count, MAX_DOTS)
  return (
    <span
      className={cn('inline-flex shrink-0 items-center align-middle', className)}
      title={title}
      aria-label={title.replace(/\n/g, ', ')}
    >
      <span className="inline-flex items-center gap-0.5">
        {Array.from({ length: dots }, (_, i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-emerald-500/80 ring-1 ring-emerald-500/15"
          />
        ))}
        {count > MAX_DOTS && (
          <span className="text-[9px] tabular-nums text-muted-foreground shrink-0">+{count - MAX_DOTS}</span>
        )}
      </span>
    </span>
  )
})
