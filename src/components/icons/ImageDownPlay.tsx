import { createLucideIcon } from 'lucide-react'

/**
 * Custom icon: ImageDown with a play triangle overlay.
 * Used on nondownloaded video cards to indicate "download to play".
 * SVG source: ImageDown + play path; viewBox 0 0 24 24, stroke 1.5.
 */
export const ImageDownPlay = createLucideIcon('ImageDownPlay', [
  [
    'path',
    {
      d: 'M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21',
    },
  ],
  ['path', { d: 'm14 19 3 3v-5.5' }],
  ['path', { d: 'm17 22 3-3' }],
  [
    'path',
    {
      d: 'M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z',
      transform: 'translate(-3 -0)',
    },
  ],
])
