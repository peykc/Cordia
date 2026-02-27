import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'

const SHOW_DELAY_MS = 400
const HIDE_DELAY_MS = 100
const GAP_PX = 6
const ARROW_SIZE = 6

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  content: ReactNode
  side?: TooltipSide
  children: ReactNode
  /** Optional class for the trigger wrapper (e.g. to preserve flex layout). */
  className?: string
  /** Keep native title as fallback for very slow hover / a11y. */
  title?: string
}

export function Tooltip({
  content,
  side = 'top',
  children,
  className,
  title,
}: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const tooltipWidth = 140
    const tooltipHeight = 28
    let left = 0
    let top = 0
    switch (side) {
      case 'top':
        left = rect.left + rect.width / 2 - tooltipWidth / 2
        top = rect.top - tooltipHeight - GAP_PX - ARROW_SIZE
        break
      case 'bottom':
        left = rect.left + rect.width / 2 - tooltipWidth / 2
        top = rect.bottom + GAP_PX + ARROW_SIZE
        break
      case 'left':
        left = rect.left - tooltipWidth - GAP_PX - ARROW_SIZE
        top = rect.top + rect.height / 2 - tooltipHeight / 2
        break
      case 'right':
        left = rect.right + GAP_PX + ARROW_SIZE
        top = rect.top + rect.height / 2 - tooltipHeight / 2
        break
    }
    const margin = 8
    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipWidth - margin))
    top = Math.max(margin, Math.min(top, window.innerHeight - tooltipHeight - margin))
    setPosition({ left, top })
  }, [side])

  const show = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
    if (showTimeoutRef.current) return
    showTimeoutRef.current = setTimeout(() => {
      showTimeoutRef.current = null
      updatePosition()
      setOpen(true)
    }, SHOW_DELAY_MS)
  }, [updatePosition])

  const hide = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
      showTimeoutRef.current = null
    }
    hideTimeoutRef.current = setTimeout(() => {
      hideTimeoutRef.current = null
      setOpen(false)
      setPosition(null)
    }, HIDE_DELAY_MS)
  }, [])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => updatePosition()
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, updatePosition])

  useEffect(() => {
    return () => {
      if (showTimeoutRef.current) clearTimeout(showTimeoutRef.current)
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
    }
  }, [])

  const tooltipEl = open && position && (
    <div
      className="fixed z-[100] px-3 py-1.5 text-sm font-light text-popover-foreground bg-popover border border-border rounded-md shadow-lg whitespace-nowrap pointer-events-none"
      style={{
        left: position.left,
        top: position.top,
        maxWidth: 240,
      }}
      role="tooltip"
      onMouseEnter={() => {
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current)
          hideTimeoutRef.current = null
        }
      }}
      onMouseLeave={hide}
    >
      {content}
      {/* Arrow pointing to trigger (triangle pointing down when tooltip is above) */}
      <span
        className={cn(
          'absolute w-0 h-0 border-[6px] border-transparent',
          side === 'top' && 'left-1/2 -translate-x-1/2 top-full border-t-popover border-l-transparent border-r-transparent border-b-transparent',
          side === 'bottom' && 'left-1/2 -translate-x-1/2 bottom-full border-b-popover border-l-transparent border-r-transparent border-t-transparent',
          side === 'left' && 'top-1/2 -translate-y-1/2 left-full border-l-popover border-t-transparent border-b-transparent border-r-transparent',
          side === 'right' && 'top-1/2 -translate-y-1/2 right-full border-r-popover border-t-transparent border-b-transparent border-l-transparent'
        )}
        style={
          side === 'top'
            ? { marginTop: -1 }
            : side === 'bottom'
              ? { marginBottom: -1 }
              : side === 'left'
                ? { marginLeft: -1 }
                : { marginRight: -1 }
        }
        aria-hidden
      />
    </div>
  )

  return (
    <>
      <div
        ref={triggerRef}
        className={cn('inline-flex', className)}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        title={title}
      >
        {children}
      </div>
      {typeof document !== 'undefined' && createPortal(tooltipEl, document.body)}
    </>
  )
}
