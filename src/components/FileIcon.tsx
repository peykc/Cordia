import { useEffect, useRef, useState } from 'react'
import {
  FileMusic,
  FileCode,
  FileBox,
  FileType,
  Folder,
  FolderArchive,
  FileImage,
  FileVideo,
  File,
  Play,
} from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { readAttachmentBytes } from '../lib/tauri'
import { getFileTypeFromExt, type FileTypeCategory } from '../lib/fileType'

const ICON_SIZE = 20
const THUMB_SIZE = 32

type Props = {
  fileName: string
  /** For uploads: load bytes to create blob URL */
  attachmentId?: string | null
  /** For completed downloads or uploads: use local path for file/thumbnail */
  savedPath?: string | null
  /** Pre-generated thumbnail path (from ffmpeg) for video/image when savedPath is the main file */
  thumbnailPath?: string | null
  /** Called when image/video thumbnail is clicked. For video with attachmentId, url is null and attachmentId is provided for deferred loading. */
  onMediaClick?: (url: string | null, type: 'image' | 'video', attachmentId?: string, fileName?: string) => void
  className?: string
}

function IconForCategory({ cat, className }: { cat: FileTypeCategory; className?: string }) {
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
      return <FolderArchive {...common} />
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
}: Props) {
  const category = getFileTypeFromExt(fileName)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (category !== 'image' && category !== 'video') return

    let cancelled = false

    const resolve = async () => {
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
  }, [category, savedPath, thumbnailPath, attachmentId])

  const boxCls = `shrink-0 flex items-center justify-center overflow-hidden rounded bg-muted/50 ${className}`

  if (category === 'image' && mediaUrl && !loading) {
    const fullImageUrl = savedPath ? (() => { try { return convertFileSrc(savedPath) } catch { return mediaUrl } })() : mediaUrl;
    return (
      <button
        type="button"
        className={`${boxCls} cursor-pointer hover:opacity-90 transition-opacity`}
        style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
        onClick={() => onMediaClick?.(fullImageUrl, 'image', undefined, fileName)}
        title="Click to expand"
      >
        <img
          src={mediaUrl}
          alt=""
          className="w-full h-full object-cover"
        />
      </button>
    )
  }

  // Video: thumbnail from thumbnailPath or savedPath (preload=metadata), icon when neither available
  if (category === 'video' && (savedPath || attachmentId || thumbnailPath)) {
    const hasThumbnail = mediaUrl && (thumbnailPath || savedPath)
    return (
      <button
        type="button"
        className={`${boxCls} relative cursor-pointer hover:opacity-90 transition-opacity group`}
        style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
        onClick={() => {
          if (savedPath) {
            onMediaClick?.(convertFileSrc(savedPath), 'video', undefined, fileName)
          } else if (attachmentId) {
            onMediaClick?.(null, 'video', attachmentId, fileName)
          }
        }}
        title="Click to play"
      >
        {hasThumbnail ? (
          <>
            <video
              src={mediaUrl}
              className="w-full h-full object-cover"
              muted
              playsInline
              preload="metadata"
            />
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

  // Fallback: icon
  return (
    <div
      className={boxCls}
      style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
    >
      <IconForCategory cat={category} className="text-muted-foreground" />
    </div>
  )
}
