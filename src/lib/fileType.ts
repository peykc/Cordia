/** File type categories for icon selection and media preview */
export type FileTypeCategory =
  | 'image'
  | 'video'
  | 'music'
  | 'program'
  | 'program-specific'
  | 'text'
  | 'archive'
  | 'folder'
  | 'default'

const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tiff', 'tif', 'ico', 'svg',
])

const VIDEO_EXT = new Set([
  'mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v', 'wmv', 'flv', 'mpeg', 'mpg', '3gp', 'ogv',
])

const MUSIC_EXT = new Set([
  'mp3', 'flac', 'wav', 'opus', 'ogg', 'm4a', 'aac', 'wma', 'oga', 'webm', 'aiff', 'aif',
])

const PROGRAM_EXT = new Set([
  'exe', 'osx', 'bat', 'app', 'apk', 'msi', 'deb', 'rpm', 'dmg', 'sh', 'cmd', 'ps1', 'com',
])

const PROGRAM_SPECIFIC_EXT = new Set([
  'psd', 'xlsx', 'xls', 'glb', 'gltf', 'fbx', 'blend', 'obj', '3ds', 'max', 'sketch',
  'fig', 'indd', 'ai', 'dwg', 'dxf', 'rvt', 'rfa', 'pptx', 'ppt', 'doc', 'docm',
])

const TEXT_EXT = new Set([
  'json', 'txt', 'log', 'html', 'htm', 'docx', 'md', 'xml', 'csv', 'yaml', 'yml',
  'ini', 'cfg', 'conf', 'env', 'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sql', 'r', 'swift', 'kt',
])

const ARCHIVE_EXT = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'z', 'xz', 'lz', 'lz4', 'zst',
  'cab', 'jar', 'war', 'ear', 'iso', 'dmg',
])

const FOLDER_EXT = new Set(['folder'])

/** Get lowercase extension from filename (without leading dot) */
export function getExtension(filename: string): string {
  const raw = (filename ?? '').trim()
  const lastDot = raw.lastIndexOf('.')
  if (lastDot > 0 && lastDot < raw.length - 1) {
    return raw.slice(lastDot + 1).toLowerCase()
  }
  return ''
}

/** Map extension to file type category for icon/preview */
export function getFileTypeFromExt(filename: string): FileTypeCategory {
  const ext = getExtension(filename)
  if (!ext) return 'default'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (MUSIC_EXT.has(ext)) return 'music'
  if (PROGRAM_EXT.has(ext)) return 'program'
  if (PROGRAM_SPECIFIC_EXT.has(ext)) return 'program-specific'
  if (TEXT_EXT.has(ext)) return 'text'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (FOLDER_EXT.has(ext)) return 'folder'
  return 'default'
}

/** Whether this type shows a media thumbnail (image or video) */
export function isMediaType(cat: FileTypeCategory): boolean {
  return cat === 'image' || cat === 'video'
}
