import { useEffect, useMemo, useRef, useState } from 'react'

function splitExt(name: string): { base: string; ext: string } {
  const raw = (name ?? '').trim()
  const lastDot = raw.lastIndexOf('.')
  const hasExt = lastDot > 0 && lastDot < raw.length - 1
  if (!hasExt) return { base: raw, ext: '' }
  return { base: raw.slice(0, lastDot), ext: raw.slice(lastDot) } // ext includes "."
}

function getFontFor(el: HTMLElement): string {
  const style = window.getComputedStyle(el)
  // `font` is the full shorthand in Chromium-based webviews.
  return style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
}

function measureTextPx(text: string, font: string, ctx: CanvasRenderingContext2D): number {
  ctx.font = font
  return ctx.measureText(text).width
}

function ellipsizeKeepExtToWidth(name: string, maxPx: number, font: string, ctx: CanvasRenderingContext2D): string {
  const raw = (name ?? '').trim()
  if (!raw) return raw
  if (maxPx <= 0) return raw
  if (measureTextPx(raw, font, ctx) <= maxPx) return raw

  const { base, ext } = splitExt(raw)
  const dots = '...'
  if (!ext) {
    // End-ellipsis fallback.
    let lo = 0
    let hi = raw.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      const candidate = raw.slice(0, mid) + dots
      if (measureTextPx(candidate, font, ctx) <= maxPx) lo = mid
      else hi = mid - 1
    }
    return raw.slice(0, Math.max(1, lo)) + dots
  }

  const extPx = measureTextPx(ext, font, ctx)
  const dotsPx = measureTextPx(dots, font, ctx)
  // If extension alone almost fills it, show just "...ext"
  if (extPx + dotsPx > maxPx) return dots + ext

  // Binary search best prefix length of base.
  let lo = 0
  let hi = base.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate = base.slice(0, mid) + dots + ext
    if (measureTextPx(candidate, font, ctx) <= maxPx) lo = mid
    else hi = mid - 1
  }
  return base.slice(0, Math.max(1, lo)) + dots + ext
}

type Props = {
  name: string
  className?: string
  /** Optional override; default is `name` */
  title?: string
}

export function FilenameEllipsis({ name, className, title }: Props) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [display, setDisplay] = useState(name)

  const canvasCtx = useMemo(() => {
    const canvas = document.createElement('canvas')
    return canvas.getContext('2d')
  }, [])

  useEffect(() => {
    setDisplay(name)
  }, [name])

  useEffect(() => {
    const el = ref.current
    if (!el || !canvasCtx) return

    const recompute = () => {
      const maxPx = el.clientWidth
      if (maxPx <= 0) return
      const font = getFontFor(el)
      const next = ellipsizeKeepExtToWidth(name, maxPx, font, canvasCtx)
      setDisplay(next)
    }

    recompute()

    const ro = new ResizeObserver(() => recompute())
    ro.observe(el)
    return () => ro.disconnect()
  }, [name, canvasCtx])

  return (
    <span ref={ref} className={className} title={title ?? name}>
      {display}
    </span>
  )
}

