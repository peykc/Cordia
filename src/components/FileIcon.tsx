import { useEffect, useRef, useState } from 'react'
import {
  FileMusic,
  FileCode,
  FileBox,
  FileType,
  Folder,
  FileArchive,
  FileImage,
  FileVideo,
  File,
  Play,
} from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { ensureMusicCoverThumbnail, getCachedMusicCoverPath, readAttachmentBytes } from '../lib/tauri'
import { getFileTypeFromExt, type FileTypeCategory } from '../lib/fileType'
import { cn } from '../lib/utils'

const ICON_SIZE = 20
const THUMB_SIZE = 32

type Props = {
  fileName: string
  /** For uploads: load bytes to create blob URL */
  attachmentId?: string | null
  /** For completed downloads or uploads: use local path for file/thumbnail */
  savedPath?: string | null
  /** Video/image: ffmpeg thumb or tiered image path. Music: `thumbs/{id}_music.jpg` when already prepared (same file as chat). */
  thumbnailPath?: string | null
  /**
   * Called when image/video thumbnail is clicked. For video with attachmentId, url is null and attachmentId is provided for deferred loading.
   * For music with local audio + attachmentId, pass `opts.musicCoverFullSourcePath` so the overlay loads full-res embed (not the list thumb `url`).
   */
  onMediaClick?: (
    url: string | null,
    type: 'image' | 'video' | 'audio',
    attachmentId?: string,
    fileName?: string,
    opts?: { musicCoverFullSourcePath?: string | null; /** When `attachmentId` is missing (e.g. composer staging) */ localPath?: string | null }
  ) => void
  className?: string
  /** Override box size in pixels (default THUMB_SIZE) */
  boxSize?: number
  /** Sharp corners + square frame (e.g. transfer center list) */
  squareThumb?: boolean
}

export function IconForCategory({ cat, className }: { cat: FileTypeCategory; className?: string }) {
  const common = { className, size: ICON_SIZE }
  switch (cat) {
    case 'music':
      return <FileMusic {...common} />
    case 'program':
      return <FileCode {...common} />
    case 'program-specific':
      return <FileBox {...common} />
    case 'text':
      return <FileType {...common} />
    case 'archive':
      return <FileArchive {...common} />
    case 'folder':
      return <Folder {...common} />
    case 'image':
      return <FileImage {...common} />
    case 'video':
      return <FileVideo {...common} />
    default:
      return <File {...common} />
  }
}

export function FileIcon({
  fileName,
  attachmentId,
  savedPath,
  thumbnailPath,
  onMediaClick,
  className = '',
  boxSize = THUMB_SIZE,
  squareThumb = false,
}: Props) {
  const category = getFileTypeFromExt(fileName)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** Stale `thumbnailPath` in DB can point at a missing file — skip thumb and use `ensure` like chat. */
  const [musicThumbPathFailed, setMusicThumbPathFailed] = useState(false)
  /** True while the current `mediaUrl` came from `thumbnailPath` (so `onError` can retry with ensure). */
  const musicCoverFromThumbRef = useRef(false)
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    setMusicThumbPathFailed(false)
  }, [thumbnailPath, attachmentId, savedPath, fileName])

  useEffect(() => {
    if (category !== 'image' && category !== 'video' && category !== 'music') return

    let cancelled = false

    const resolve = async () => {
      if (category === 'music') {
        const thumb = thumbnailPath?.trim()
        if (thumb && !musicThumbPathFailed) {
          try {
            musicCoverFromThumbRef.current = true
            const url = convertFileSrc(thumb)
            if (!cancelled) setMediaUrl(url)
          } catch {
            musicCoverFromThumbRef.current = false
            if (!cancelled) {
              setMediaUrl(null)
              setMusicThumbPathFailed(true)
            }
          }
          return
        }
        musicCoverFromThumbRef.current = false
        if (!cancelled) setMediaUrl(null)
        const aid = attachmentId?.trim()
        const sp = savedPath?.trim()
        if (aid && sp) {
          const cached = getCachedMusicCoverPath(aid)
          if (cached !== undefined) {
            if (!cancelled) {
              if (cached) {
                try {
                  setMediaUrl(convertFileSrc(cached))
                } catch {
                  setMediaUrl(null)
                }
              } else {
                setMediaUrl(null)
              }
            }
            return
          }
          setLoading(true)
          try {
            const p = await ensureMusicCoverThumbnail(aid, sp)
            if (!cancelled) {
              if (p) {
                try {
                  setMediaUrl(convertFileSrc(p))
                } catch {
                  setMediaUrl(null)
                }
              } else {
                setMediaUrl(null)
              }
            }
          } catch {
            if (!cancelled) setMediaUrl(null)
          } finally {
            if (!cancelled) setLoading(false)
          }
        } else {
          if (!cancelled) setMediaUrl(null)
        }
        return
      }

      if (category === 'image') {
        const path = thumbnailPath || savedPath
        if (path) {
          try {
            const url = convertFileSrc(path)
            if (!cancelled) setMediaUrl(url)
          } catch {
            if (!cancelled) setMediaUrl(null)
          }
          return
        }
        if (attachmentId) {
          setLoading(true)
          try {
            const bytes = await readAttachmentBytes(attachmentId)
            const blob = new Blob([new Uint8Array(bytes)])
            const url = URL.createObjectURL(blob)
            blobUrlRef.current = url
            if (!cancelled) setMediaUrl(url)
          } catch {
            if (!cancelled) setMediaUrl(null)
          } finally {
            if (!cancelled) setLoading(false)
          }
          return
        }
      }

      // Video thumbnail: use thumbnailPath (ffmpeg) if available, else savedPath with preload=metadata
      if (category === 'video') {
        const path = thumbnailPath || savedPath
        if (path) {
          try {
            const url = convertFileSrc(path)
            if (!cancelled) setMediaUrl(url)
          } catch {
            if (!cancelled) setMediaUrl(null)
          }
          return
        }
        if (attachmentId) {
          setLoading(true)
          try {
            const bytes = await readAttachmentBytes(attachmentId)
            const blob = new Blob([new Uint8Array(bytes)])
            const url = URL.createObjectURL(blob)
            blobUrlRef.current = url
            if (!cancelled) setMediaUrl(url)
          } catch {
            if (!cancelled) setMediaUrl(null)
          } finally {
            if (!cancelled) setLoading(false)
          }
        }
        return
      }

      if (!cancelled) setMediaUrl(null)
    }

    resolve()
    return () => {
      cancelled = true
      const toRevoke = blobUrlRef.current
      if (toRevoke) {
        URL.revokeObjectURL(toRevoke)
        blobUrlRef.current = null
      }
    }
  }, [category, savedPath, thumbnailPath, attachmentId, musicThumbPathFailed])

  const boxCls = cn(
    'shrink-0 flex items-center justify-center overflow-hidden bg-muted/50',
    squareThumb ? 'rounded-none border border-border/50' : 'rounded',
    className
  )

  if (category === 'image' && mediaUrl && !loading) {
    const fullImageUrl = savedPath ? (() => { try { return convertFileSrc(savedPath) } catch { return mediaUrl } })() : mediaUrl;
    return (
      <button
        type="button"
        className={`${boxCls} relative cursor-pointer group`}
        style={{ width: boxSize, height: boxSize }}
        onClick={() => onMediaClick?.(fullImageUrl, 'image', undefined, fileName)}
      >
        <img
          src={mediaUrl}
          alt=""
          className="w-full h-full object-cover"
        />
        {/* Darken on hover only (video thumbs stay slightly dimmed for play affordance) */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20"
        />
      </button>
    )
  }

  // Video: thumbnail from thumbnailPath or savedPath (preload=metadata), icon when neither available
  if (category === 'video' && (savedPath || attachmentId || thumbnailPath)) {
    const hasThumbnail = !!mediaUrl
    const hasImageThumb = !!thumbnailPath
    return (
      <button
        type="button"
        className={`${boxCls} relative cursor-pointer group`}
        style={{ width: boxSize, height: boxSize }}
        onClick={() => {
          if (savedPath) {
            onMediaClick?.(convertFileSrc(savedPath), 'video', undefined, fileName)
          } else if (mediaUrl) {
            onMediaClick?.(mediaUrl, 'video', undefined, fileName)
          } else if (attachmentId) {
            onMediaClick?.(null, 'video', attachmentId, fileName)
          }
        }}
      >
        {hasThumbnail ? (
          <>
            {hasImageThumb ? (
              <img
                src={mediaUrl}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <video
                src={mediaUrl}
                className="w-full h-full object-cover"
                muted
                playsInline
                preload="metadata"
              />
            )}
            <span className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
              <Play className="w-4 h-4 text-white fill-white" />
            </span>
          </>
        ) : (
          <>
            <FileVideo className="w-5 h-5 text-muted-foreground" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
              <Play className="w-4 h-4 text-white fill-white" />
            </span>
          </>
        )}
      </button>
    )
  }

  // Music: same `thumbs/{id}_music.jpg` as chat (thumbnailPath or ensure from local audio); else music icon
  if (category === 'music' && mediaUrl && !loading) {
    return (
      <button
        type="button"
        className={`${boxCls} relative cursor-pointer group`}
        style={{ width: boxSize, height: boxSize }}
        onClick={() => {
          const sp = savedPath?.trim()
          const aid = attachmentId?.trim()
          if (sp && aid) {
            onMediaClick?.(null, 'audio', aid, fileName, { musicCoverFullSourcePath: sp, localPath: sp })
          } else {
            onMediaClick?.(mediaUrl, 'image', undefined, fileName)
          }
        }}
      >
        <img
          src={mediaUrl}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => {
            setMediaUrl(null)
            if (musicCoverFromThumbRef.current) {
              musicCoverFromThumbRef.current = false
              setMusicThumbPathFailed(true)
            }
          }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20"
        />
      </button>
    )
  }

  // Fallback: icon (music with local file opens audio modal; icon as cover when list had no art)
  if (category === 'music') {
    const sp = savedPath?.trim()
    const aid = attachmentId?.trim()
    if (sp && aid) {
      return (
        <button
          type="button"
          className={`${boxCls} relative cursor-pointer group`}
          style={{ width: boxSize, height: boxSize }}
          onClick={() =>
            onMediaClick?.(null, 'audio', aid, fileName, { musicCoverFullSourcePath: null, localPath: sp })
          }
        >
          <IconForCategory cat="music" className="text-muted-foreground" />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20"
          />
        </button>
      )
    }
    if (sp && !aid) {
      return (
        <button
          type="button"
          className={`${boxCls} relative cursor-pointer group`}
          style={{ width: boxSize, height: boxSize }}
          onClick={() =>
            onMediaClick?.(null, 'audio', undefined, fileName, { musicCoverFullSourcePath: null, localPath: sp })
          }
        >
          <IconForCategory cat="music" className="text-muted-foreground" />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20"
          />
        </button>
      )
    }
  }

  return (
    <div className={boxCls} style={{ width: boxSize, height: boxSize }}>
      <IconForCategory cat={category} className="text-muted-foreground" />
    </div>
  )
}
