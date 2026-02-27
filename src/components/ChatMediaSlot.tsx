import { type ReactNode } from 'react'
import { cn } from '../lib/utils'

/** 4:1 aspect file row with shimmer: icon on left, title and size (below) on the right. Used for non-media attachments (e.g. zip). */
export function ChatFileRowSlot({
  className,
  icon,
  title,
  size,
  children,
}: {
  className?: string
  icon: ReactNode
  title: string
  size: string
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative w-full overflow-hidden rounded-lg bg-muted aspect-[7/1] min-h-[64px]',
        className
      )}
    >
      <div
        className="absolute inset-0 bg-gradient-to-r from-muted via-muted-foreground/10 to-muted bg-[length:200%_100%] animate-shimmer"
        aria-hidden
      />
      <div className="absolute inset-0 flex items-center gap-3 px-3 py-2 bg-card">
        <span className="shrink-0 flex items-center justify-center text-muted-foreground [&>svg]:size-5">
          {icon}
        </span>
        <div className="min-w-0 flex-1 flex flex-col justify-center gap-0.5">
          <span className="text-sm font-medium truncate" title={title}>
            {title}
          </span>
          <span className="text-xs text-muted-foreground">{size}</span>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Fixed-aspect container with loading shimmer; media lazy-loads inside so layout doesn't shift. */
export function ChatMediaSlot({
  className,
  aspectClass,
  maxHClass,
  fillParent,
  children,
}: {
  className?: string
  /** e.g. aspect-video, aspect-square, aspect-[4/3]. Omit when fillParent is true (parent controls aspect). */
  aspectClass?: string
  /** e.g. max-h-[240px], max-h-[min(70vh,24rem)] */
  maxHClass?: string
  /** When true, slot fills parent (w-full h-full); use when parent sets aspect ratio. */
  fillParent?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg bg-muted',
        fillParent ? 'w-full h-full min-h-0 min-w-0' : 'w-full',
        !fillParent && aspectClass,
        !fillParent && maxHClass,
        className
      )}
    >
      <div
        className="absolute inset-0 bg-gradient-to-r from-muted via-muted-foreground/10 to-muted bg-[length:200%_100%] animate-shimmer"
        aria-hidden
      />
      <div className="absolute inset-0 [&>img]:w-full [&>img]:h-full [&>img]:object-cover [&>video]:w-full [&>video]:h-full [&>video]:object-cover">
        {children}
      </div>
    </div>
  )
}
