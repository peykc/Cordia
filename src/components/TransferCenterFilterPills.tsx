import { memo, useLayoutEffect, useRef } from 'react'
import { cn } from '../lib/utils'
import {
  TRANSFER_FILTER_OPTIONS,
  type TransferFileFilter,
} from '../lib/transferCenterFilters'

/** Horizontally center the selected pill in the filter strip (clamped; same idea as media gallery thumbs). */
function scrollTransferFilterStripToCenterPill(
  strip: HTMLElement,
  pill: HTMLElement,
  behavior: ScrollBehavior = 'smooth'
) {
  const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth)
  if (maxScroll <= 0) return
  const centerX = pill.offsetLeft + pill.offsetWidth / 2
  const left = Math.max(0, Math.min(centerX - strip.clientWidth / 2, maxScroll))
  strip.scrollTo({ left, behavior })
}

export const FilterPills = memo(function FilterPills({
  value,
  onChange,
  compact,
}: {
  value: TransferFileFilter
  onChange: (f: TransferFileFilter) => void
  compact?: boolean
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const centerSelected = (behavior: ScrollBehavior) => {
    const strip = stripRef.current
    if (!strip) return
    const pill = strip.querySelector<HTMLElement>(`[data-transfer-filter="${CSS.escape(valueRef.current)}"]`)
    if (pill) scrollTransferFilterStripToCenterPill(strip, pill, behavior)
  }

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => centerSelected('smooth'))
    return () => cancelAnimationFrame(id)
  }, [value])

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => centerSelected('auto'))
    })
    ro.observe(strip)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={stripRef}
      className={cn(
        'relative flex min-w-0 flex-nowrap gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x [scrollbar-width:thin]',
        compact ? 'gap-0.5' : 'gap-1'
      )}
    >
      {TRANSFER_FILTER_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          data-transfer-filter={opt.id}
          onClick={() => onChange(opt.id)}
          className={cn(
            'shrink-0 rounded-md border text-[10px] font-medium transition-colors',
            compact ? 'px-1.5 py-0.5' : 'px-2 py-1',
            value === opt.id
              ? 'border-accent/60 bg-accent/15 text-foreground'
              : 'border-border/50 bg-background/40 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
})
