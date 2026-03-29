import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'

const DEFAULT_SHOW_DELAY_MS = 400
const DEFAULT_HIDE_DELAY_MS = 100
/** Default 0 keeps existing app tooltips snappy; pass `fadeMs` for quick fades on detail hovers. */
const DEFAULT_FADE_MS = 0
const GAP_PX = 6
const ARROW_SIZE = 6
const VIEW_MARGIN = 8

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  content: ReactNode
  side?: TooltipSide
  children: ReactNode
  /** Optional class for the trigger wrapper (e.g. to preserve flex layout). */
  className?: string
  /** Optional class for the floating tooltip panel (e.g. multiline / min-width). */
  contentClassName?: string
  /** Keep native title as fallback for very slow hover / a11y. */
  title?: string
  /** Delay before opening (ms). Use `0` for immediate show on hover. */
  showDelayMs?: number
  /** Delay before closing after unhover (ms). Use `0` for immediate hide. */
  hideDelayMs?: number
  /** Opacity transition length (ms). Use `0` for no fade. */
  fadeMs?: number
  /** Close when the user presses the trigger (before click); useful for buttons that stay hovered. */
  dismissOnTriggerPointerDown?: boolean
  /** Cap for long labels (px). */
  maxContentWidthPx?: number
}

/** Keep arrow tip inside the panel by this inset from each edge (px). */
const ARROW_EDGE_INSET = 10

function computePlacement(
  side: TooltipSide,
  trigger: DOMRect,
  float: DOMRect,
  flip: boolean
): { left: number; top: number; effSide: TooltipSide; arrowOffsetX: number; arrowOffsetY: number } {
  let left = 0
  let top = 0
  let effSide = side

  const placeTop = () => {
    left = trigger.left + trigger.width / 2 - float.width / 2
    top = trigger.top - GAP_PX - float.height
  }
  const placeBottom = () => {
    left = trigger.left + trigger.width / 2 - float.width / 2
    top = trigger.bottom + GAP_PX + ARROW_SIZE
  }
  const placeLeft = () => {
    left = trigger.left - GAP_PX - float.width - ARROW_SIZE
    top = trigger.top + trigger.height / 2 - float.height / 2
  }
  const placeRight = () => {
    left = trigger.right + GAP_PX + ARROW_SIZE
    top = trigger.top + trigger.height / 2 - float.height / 2
  }

  switch (side) {
    case 'top':
      placeTop()
      if (
        flip &&
        top < VIEW_MARGIN &&
        trigger.bottom + GAP_PX + ARROW_SIZE + float.height + VIEW_MARGIN <= window.innerHeight
      ) {
        placeBottom()
        effSide = 'bottom'
      }
      break
    case 'bottom':
      placeBottom()
      if (
        flip &&
        trigger.bottom + GAP_PX + ARROW_SIZE + float.height > window.innerHeight - VIEW_MARGIN &&
        trigger.top - GAP_PX - float.height >= VIEW_MARGIN
      ) {
        placeTop()
        effSide = 'top'
      }
      break
    case 'left':
      placeLeft()
      if (
        flip &&
        left < VIEW_MARGIN &&
        trigger.right + GAP_PX + float.width + ARROW_SIZE <= window.innerWidth - VIEW_MARGIN
      ) {
        placeRight()
        effSide = 'right'
      }
      break
    case 'right':
      placeRight()
      if (
        flip &&
        left + float.width > window.innerWidth - VIEW_MARGIN &&
        trigger.left - GAP_PX - float.width - ARROW_SIZE >= VIEW_MARGIN
      ) {
        placeLeft()
        effSide = 'left'
      }
      break
  }

  left = Math.max(VIEW_MARGIN, Math.min(left, window.innerWidth - float.width - VIEW_MARGIN))
  top = Math.max(VIEW_MARGIN, Math.min(top, window.innerHeight - float.height - VIEW_MARGIN))

  const triggerCX = trigger.left + trigger.width / 2
  const triggerCY = trigger.top + trigger.height / 2
  let arrowOffsetX = 0
  let arrowOffsetY = 0

  if (effSide === 'top' || effSide === 'bottom') {
    const lo = left + ARROW_EDGE_INSET
    const hi = left + float.width - ARROW_EDGE_INSET
    const arrowCenterX = Math.max(lo, Math.min(triggerCX, hi))
    arrowOffsetX = arrowCenterX - (left + float.width / 2)
  } else {
    const lo = top + ARROW_EDGE_INSET
    const hi = top + float.height - ARROW_EDGE_INSET
    const arrowCenterY = Math.max(lo, Math.min(triggerCY, hi))
    arrowOffsetY = arrowCenterY - (top + float.height / 2)
  }

  return { left, top, effSide, arrowOffsetX, arrowOffsetY }
}

export function Tooltip({
  content,
  side = 'top',
  children,
  className,
  contentClassName,
  title,
  showDelayMs = DEFAULT_SHOW_DELAY_MS,
  hideDelayMs = DEFAULT_HIDE_DELAY_MS,
  fadeMs = DEFAULT_FADE_MS,
  dismissOnTriggerPointerDown = false,
  maxContentWidthPx = 360,
}: TooltipProps) {
  const [mounted, setMounted] = useState(false)
  const [coords, setCoords] = useState<{
    left: number
    top: number
    arrowOffsetX: number
    arrowOffsetY: number
  } | null>(null)
  const [effSide, setEffSide] = useState<TooltipSide>(side)
  const [opaque, setOpaque] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const floatRef = useRef<HTMLDivElement>(null)
  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeOutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearFadeOut = useCallback(() => {
    if (fadeOutTimeoutRef.current) {
      clearTimeout(fadeOutTimeoutRef.current)
      fadeOutTimeoutRef.current = null
    }
  }, [])

  const measureAndPlace = useCallback(() => {
    const trEl = triggerRef.current
    const flEl = floatRef.current
    if (!trEl || !flEl) return
    const trigger = trEl.getBoundingClientRect()
    const float = flEl.getBoundingClientRect()
    const { left, top, effSide: nextSide, arrowOffsetX, arrowOffsetY } = computePlacement(
      side,
      trigger,
      float,
      true
    )
    setCoords({ left, top, arrowOffsetX, arrowOffsetY })
    setEffSide(nextSide)
  }, [side])

  const unmountTooltip = useCallback(() => {
    clearFadeOut()
    setMounted(false)
    setCoords(null)
    setOpaque(false)
    setEffSide(side)
  }, [clearFadeOut, side])

  const startHide = useCallback(() => {
    if (fadeMs <= 0) {
      unmountTooltip()
      return
    }
    setOpaque(false)
    clearFadeOut()
    fadeOutTimeoutRef.current = setTimeout(() => {
      fadeOutTimeoutRef.current = null
      unmountTooltip()
    }, fadeMs)
  }, [fadeMs, unmountTooltip, clearFadeOut])

  const hide = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
      showTimeoutRef.current = null
    }
    if (!mounted) return
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
    hideTimeoutRef.current = setTimeout(() => {
      hideTimeoutRef.current = null
      startHide()
    }, hideDelayMs)
  }, [mounted, hideDelayMs, startHide])

  const show = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
    clearFadeOut()
    if (mounted) {
      setOpaque(true)
      requestAnimationFrame(() => measureAndPlace())
      return
    }
    if (showTimeoutRef.current) return
    showTimeoutRef.current = setTimeout(() => {
      showTimeoutRef.current = null
      setMounted(true)
      setOpaque(false)
      setCoords(null)
    }, showDelayMs)
  }, [mounted, showDelayMs, clearFadeOut, measureAndPlace])

  useLayoutEffect(() => {
    if (!mounted) return
    measureAndPlace()
    if (fadeMs <= 0) {
      setOpaque(true)
      return
    }
    const id = requestAnimationFrame(() => setOpaque(true))
    return () => cancelAnimationFrame(id)
  }, [mounted, measureAndPlace, fadeMs])

  useEffect(() => {
    if (!mounted) return
    const onScrollOrResize = () => measureAndPlace()
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [mounted, measureAndPlace])

  useEffect(() => {
    return () => {
      if (showTimeoutRef.current) clearTimeout(showTimeoutRef.current)
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
      clearFadeOut()
    }
  }, [clearFadeOut])

  const onTriggerPointerDown = useCallback(() => {
    if (!dismissOnTriggerPointerDown || !mounted) return
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
      showTimeoutRef.current = null
    }
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
    startHide()
  }, [dismissOnTriggerPointerDown, mounted, startHide])

  const tooltipEl = mounted && (
    <div
      ref={floatRef}
      className={cn(
        'fixed z-[100] rounded-lg border border-border bg-popover px-3 py-1.5 text-sm font-light text-popover-foreground shadow-lg pointer-events-none',
        fadeMs > 0 && 'transition-opacity ease-out',
        fadeMs > 0 && (opaque ? 'opacity-100' : 'opacity-0'),
        contentClassName ?? 'whitespace-nowrap'
      )}
      style={{
        left: coords?.left ?? 0,
        top: coords?.top ?? 0,
        visibility: coords ? 'visible' : 'hidden',
        maxWidth: `min(${maxContentWidthPx}px, calc(100vw - 16px))`,
        transitionDuration: fadeMs > 0 ? `${fadeMs}ms` : undefined,
      }}
      role="tooltip"
    >
      {content}
      <span
        className={cn(
          'absolute w-0 h-0 border-[6px] border-transparent',
          effSide === 'top' && 'top-full border-t-popover border-l-transparent border-r-transparent border-b-transparent',
          effSide === 'bottom' &&
            'bottom-full border-b-popover border-l-transparent border-r-transparent border-t-transparent',
          effSide === 'left' &&
            'left-full border-l-popover border-t-transparent border-b-transparent border-r-transparent',
          effSide === 'right' &&
            'right-full border-r-popover border-t-transparent border-b-transparent border-l-transparent'
        )}
        style={
          effSide === 'top'
            ? {
                left: `calc(50% + ${coords?.arrowOffsetX ?? 0}px)`,
                transform: 'translateX(-50%)',
                marginTop: -1,
              }
            : effSide === 'bottom'
              ? {
                  left: `calc(50% + ${coords?.arrowOffsetX ?? 0}px)`,
                  transform: 'translateX(-50%)',
                  marginBottom: -1,
                }
              : effSide === 'left'
                ? {
                    top: `calc(50% + ${coords?.arrowOffsetY ?? 0}px)`,
                    transform: 'translateY(-50%)',
                    marginLeft: -1,
                  }
                : {
                    top: `calc(50% + ${coords?.arrowOffsetY ?? 0}px)`,
                    transform: 'translateY(-50%)',
                    marginRight: -1,
                  }
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
        onPointerDown={onTriggerPointerDown}
        title={title}
      >
        {children}
      </div>
      {typeof document !== 'undefined' && createPortal(tooltipEl, document.body)}
    </>
  )
}
