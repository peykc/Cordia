import { useCallback, useRef } from 'react'
import {
  getCurrent,
  LogicalSize,
  LogicalPosition,
} from '@tauri-apps/api/window'

const EDGE_SIZE = 16
const CORNER_SIZE = 24
const MIN_WIDTH = 375
const MIN_HEIGHT = 425

type ResizeDirection =
  | 'n' | 's' | 'e' | 'w'
  | 'ne' | 'nw' | 'se' | 'sw'

export function WindowResizeHandles() {
  const stateRef = useRef<{
    startX: number
    startY: number
    startW: number
    startH: number
    startPosX: number
    startPosY: number
    scale: number
  } | null>(null)

  const handlePointerDown = useCallback(
    async (e: React.PointerEvent, dir: ResizeDirection) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)

      const appWindow = getCurrent()
      const [size, pos, scale] = await Promise.all([
        appWindow.innerSize(),
        appWindow.outerPosition(),
        appWindow.scaleFactor(),
      ])
      const logicalW = size.width / scale
      const logicalH = size.height / scale
      const logicalX = pos.x / scale
      const logicalY = pos.y / scale

      // Use screen coords so deltas stay correct when window moves (left/top resize)
      stateRef.current = {
        startX: e.screenX,
        startY: e.screenY,
        startW: logicalW,
        startH: logicalH,
        startPosX: logicalX,
        startPosY: logicalY,
        scale,
      }

      let rafId: number | null = null
      let pendingMove: PointerEvent | null = null

      const onMove = (moveEvent: PointerEvent) => {
        pendingMove = moveEvent
        if (rafId === null) {
          rafId = requestAnimationFrame(async () => {
            rafId = null
            const ev = pendingMove
            pendingMove = null
            if (!ev) return
            const s = stateRef.current
            if (!s) return

            // Convert screen delta to logical pixels
            const dx = (ev.screenX - s.startX) / s.scale
            const dy = (ev.screenY - s.startY) / s.scale

            let w = s.startW
            let h = s.startH
            let x = s.startPosX
            let y = s.startPosY

            if (dir.includes('e')) w = Math.max(MIN_WIDTH, s.startW + dx)
            if (dir.includes('w')) {
              w = Math.max(MIN_WIDTH, s.startW - dx)
              x = s.startPosX + (s.startW - w)
            }
            if (dir.includes('s')) h = Math.max(MIN_HEIGHT, s.startH + dy)
            if (dir.includes('n')) {
              h = Math.max(MIN_HEIGHT, s.startH - dy)
              y = s.startPosY + (s.startH - h)
            }

            try {
              // Set position first for left/top resize so the anchor corner moves before we resize
              if (dir.includes('w') || dir.includes('n')) {
                await appWindow.setPosition(new LogicalPosition(x, y))
              }
              await appWindow.setSize(new LogicalSize(w, h))
            } catch (_) {}
          })
        }
      }

      const onUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId)
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        stateRef.current = null
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    []
  )

  const base = 'absolute select-none touch-none z-[200] pointer-events-auto'
  const style = { WebkitAppRegion: 'no-drag' as const } as React.CSSProperties

  return (
    <>
      {/* Edges */}
      <div
        className={`${base} top-0 left-0 right-0 cursor-n-resize`}
        style={{ ...style, height: EDGE_SIZE }}
        onPointerDown={(e) => handlePointerDown(e, 'n')}
      />
      <div
        className={`${base} bottom-0 left-0 right-0 cursor-s-resize`}
        style={{ ...style, height: EDGE_SIZE }}
        onPointerDown={(e) => handlePointerDown(e, 's')}
      />
      <div
        className={`${base} top-0 right-0 bottom-0 cursor-e-resize`}
        style={{ ...style, width: EDGE_SIZE }}
        onPointerDown={(e) => handlePointerDown(e, 'e')}
      />
      <div
        className={`${base} top-0 left-0 bottom-0 cursor-w-resize`}
        style={{ ...style, width: EDGE_SIZE }}
        onPointerDown={(e) => handlePointerDown(e, 'w')}
      />
      {/* Corners */}
      <div
        className={`${base} top-0 left-0 cursor-nwse-resize`}
        style={{ ...style, width: CORNER_SIZE, height: CORNER_SIZE }}
        onPointerDown={(e) => handlePointerDown(e, 'nw')}
      />
      <div
        className={`${base} top-0 right-0 cursor-nesw-resize`}
        style={{ ...style, width: CORNER_SIZE, height: CORNER_SIZE }}
        onPointerDown={(e) => handlePointerDown(e, 'ne')}
      />
      <div
        className={`${base} bottom-0 right-0 cursor-nwse-resize`}
        style={{ ...style, width: CORNER_SIZE, height: CORNER_SIZE }}
        onPointerDown={(e) => handlePointerDown(e, 'se')}
      />
      <div
        className={`${base} bottom-0 left-0 cursor-nesw-resize`}
        style={{ ...style, width: CORNER_SIZE, height: CORNER_SIZE }}
        onPointerDown={(e) => handlePointerDown(e, 'sw')}
      />
    </>
  )
}
