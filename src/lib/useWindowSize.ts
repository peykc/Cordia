import { useState, useEffect, useRef } from 'react'

const RESIZE_DEBOUNCE_MS = 80

export function useWindowSize() {
  const [size, setSize] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  }))
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onResize = () => {
      if (timeoutRef.current != null) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        setSize({ width: window.innerWidth, height: window.innerHeight })
      }, RESIZE_DEBOUNCE_MS)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (timeoutRef.current != null) clearTimeout(timeoutRef.current)
    }
  }, [])

  return size
}
