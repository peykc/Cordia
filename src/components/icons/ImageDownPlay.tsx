import { forwardRef } from 'react'

/**
 * Custom icon: ImageDown with a play triangle overlay.
 * Used on nondownloaded video cards to indicate "download to play".
 * SVG source: ImageDown + play path; viewBox 0 0 24 24, stroke 1.5.
 * Rendered as custom SVG with keys on each path to satisfy React list key warning.
 */
const paths = [
  {
    key: 'image',
    d: 'M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21',
  },
  { key: 'line1', d: 'm14 19 3 3v-5.5' },
  { key: 'line2', d: 'm17 22 3-3' },
  {
    key: 'play',
    d: 'M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z',
    transform: 'translate(-3 -0)',
  },
] as const

export const ImageDownPlay = forwardRef<
  SVGSVGElement,
  React.SVGProps<SVGSVGElement> & { size?: number }
>(function ImageDownPlay({ color = 'currentColor', size = 24, strokeWidth = 2, className = '', ...rest }, ref) {
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={['lucide', 'lucide-image-down-play', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {paths.map((p) => (
        <path key={p.key} d={p.d} transform={'transform' in p ? p.transform : undefined} />
      ))}
    </svg>
  )
})
