import { memo } from 'react'
import { cn } from '../lib/utils'

const MAX_DOTS = 8

/** Compact visual for “how many servers this file is shared on”; full names in tooltip. */
export const ServerReplicationIndicator = memo(function ServerReplicationIndicator({
  count,
  serverNames,
  /** Same order as dots (signing pubkeys); when set with `activeSigningPubkeys`, matching servers render blue. */
  serverSigningPubkeys,
  activeSigningPubkeys,
  className,
}: {
  count: number
  serverNames?: string[]
  serverSigningPubkeys?: string[]
  activeSigningPubkeys?: ReadonlySet<string>
  className?: string
}) {
  const emptyTitle =
    count === 0
      ? 'Not shared on any server'
      : `${count} server${count !== 1 ? 's' : ''}`

  if (count <= 0) {
    return (
      <span
        className={cn('inline-flex shrink-0 text-[9px] tabular-nums text-muted-foreground/70', className)}
        title={emptyTitle}
      >
        —
      </span>
    )
  }

  const dots = Math.min(count, MAX_DOTS)
  const keys = serverSigningPubkeys
  const perKeyActive =
    activeSigningPubkeys &&
    activeSigningPubkeys.size > 0 &&
    keys &&
    keys.length >= dots

  const titleBase =
    serverNames && serverNames.length > 0 ? serverNames.join('\n') : `${count} server${count !== 1 ? 's' : ''}`
  const title = perKeyActive
    ? `${titleBase}\n\nSky dot: a peer is downloading this file on that server.`
    : titleBase

  return (
    <span
      className={cn('inline-flex shrink-0 items-center align-middle', className)}
      title={title}
      aria-label={title.replace(/\n/g, ', ')}
    >
      <span className="inline-flex items-center gap-0.5">
        {Array.from({ length: dots }, (_, i) => {
          const key = keys?.[i]?.trim() ?? ''
          const isActive = Boolean(perKeyActive && key && activeSigningPubkeys!.has(key))
          return (
            <span
              key={i}
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-[1px] ring-1',
                isActive
                  ? 'bg-sky-500/85 ring-sky-500/25'
                  : 'bg-emerald-500/80 ring-emerald-500/15'
              )}
            />
          )
        })}
        {count > MAX_DOTS && (
          <span className="text-[9px] tabular-nums text-muted-foreground shrink-0">+{count - MAX_DOTS}</span>
        )}
      </span>
    </span>
  )
})
