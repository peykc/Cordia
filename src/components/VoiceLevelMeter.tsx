import { useEffect, useRef } from 'react'

interface VoiceLevelMeterProps {
  level: number // 0-1
  threshold: number // 0-1
  isDragging: boolean
  onThresholdChange: (threshold: number) => void
}

export function VoiceLevelMeter({ level, threshold, isDragging, onThresholdChange }: VoiceLevelMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  // Handle drag interactions
  const handleInteractionMove = (clientX: number) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()

    // Account for horizontal padding (DOT_RADIUS + 2px = 10px on each side)
    const DOT_RADIUS = 8
    const xPadding = DOT_RADIUS + 2
    const barWidth = rect.width - (xPadding * 2)

    // Clamp x to padded region
    const x = Math.max(xPadding, Math.min(clientX - rect.left, rect.width - xPadding))

    // Calculate threshold relative to bar width (not full width)
    const newThreshold = (x - xPadding) / barWidth
    onThresholdChange(newThreshold)
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true
    handleInteractionMove(e.clientX)
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    isDraggingRef.current = true
    handleInteractionMove(e.touches[0].clientX)
  }

  // Set up global drag listeners
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) {
        handleInteractionMove(e.clientX)
      }
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (isDraggingRef.current && e.touches.length > 0) {
        handleInteractionMove(e.touches[0].clientX)
      }
    }

    const handleTouchEnd = () => {
      isDraggingRef.current = false
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('touchmove', handleTouchMove)
    window.addEventListener('touchend', handleTouchEnd)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [])

  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size to match container (container is 20px to accommodate dot)
    const dpr = window.devicePixelRatio || 1
    const rect = container.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const width = rect.width
    const canvasHeight = rect.height // 20px
    const DOT_RADIUS = 8

    // Add horizontal padding so dot doesn't clip on left/right edges
    const xPadding = DOT_RADIUS + 2 // Extra 2px for shadow
    const barWidth = width - (xPadding * 2) // Bar width accounting for padding

    // Bar is 8px tall, centered in the 20px canvas
    const barHeight = 8
    const radius = barHeight / 2
    const yOffset = (canvasHeight - barHeight) / 2 // Centers 8px bar in 20px canvas

    // Clear canvas
    ctx.clearRect(0, 0, width, canvasHeight)

    // Draw background zones (subtle hints) - centered with 8px bar and horizontal padding
    // Left zone (below threshold) - red tint
    ctx.fillStyle = 'rgba(239, 68, 68, 0.1)'
    ctx.fillRect(xPadding, yOffset, barWidth * threshold, barHeight)

    // Right zone (above threshold) - green tint
    ctx.fillStyle = 'rgba(34, 197, 94, 0.1)'
    ctx.fillRect(xPadding + barWidth * threshold, yOffset, barWidth * (1 - threshold), barHeight)

    // Draw voice level bar with rounded ends - centered at 8px height with horizontal padding
    if (level > 0) {
      const levelBarWidth = barWidth * level

      ctx.save()
      ctx.beginPath()
      ctx.roundRect(xPadding, yOffset, levelBarWidth, barHeight, radius)
      ctx.clip()

      // Bar base color
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
      ctx.fillRect(xPadding, yOffset, levelBarWidth, barHeight)

      // Apply color overlay based on threshold
      if (level < threshold) {
        // Fully red below threshold
        ctx.fillStyle = 'rgba(239, 68, 68, 0.7)'
        ctx.fillRect(xPadding, yOffset, levelBarWidth, barHeight)
      } else {
        // Red portion up to threshold
        ctx.fillStyle = 'rgba(239, 68, 68, 0.7)'
        ctx.fillRect(xPadding, yOffset, barWidth * threshold, barHeight)

        // Green portion after threshold
        ctx.fillStyle = 'rgba(34, 197, 94, 0.7)'
        ctx.fillRect(xPadding + barWidth * threshold, yOffset, levelBarWidth - (barWidth * threshold), barHeight)
      }

      ctx.restore()
    }

    // Draw threshold indicator dot - centered in canvas (not clipped by bar)
    const dotX = xPadding + barWidth * threshold // Offset by padding
    const dotY = canvasHeight / 2 // Center of canvas, not bar

    // Dot is slightly larger when dragging
    const activeDotRadius = isDragging ? DOT_RADIUS + 2 : DOT_RADIUS

    // Dot shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'
    ctx.shadowBlur = 4
    ctx.shadowOffsetY = 2

    // Dot outline
    ctx.beginPath()
    ctx.arc(dotX, dotY, activeDotRadius, 0, Math.PI * 2)
    ctx.fillStyle = '#000'
    ctx.fill()

    ctx.shadowColor = 'transparent'

    // Dot fill
    ctx.beginPath()
    ctx.arc(dotX, dotY, activeDotRadius - 2, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()

  }, [level, threshold, isDragging])

  return (
    <div
      ref={containerRef}
      className="relative w-full cursor-pointer select-none overflow-visible"
      style={{ height: '20px' }} // Tall enough for 8px dot radius to extend beyond 8px bar
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full rounded-full"
        style={{ background: 'transparent' }}
      />
    </div>
  )
}
