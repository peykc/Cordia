import { getFileTypeFromExt } from './fileType'

export type TransferFileFilter =
  | 'all'
  | 'image'
  | 'video'
  | 'audio'
  | 'documents'
  | 'archive'
  | 'other'

export const TRANSFER_FILTER_OPTIONS: { id: TransferFileFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'documents', label: 'Docs' },
  { id: 'archive', label: 'Archives' },
  { id: 'other', label: 'Other' },
]

export function fileMatchesTransferFilter(fileName: string, filter: TransferFileFilter): boolean {
  if (filter === 'all') return true
  const cat = getFileTypeFromExt(fileName)
  switch (filter) {
    case 'image':
      return cat === 'image'
    case 'video':
      return cat === 'video'
    case 'audio':
      return cat === 'music'
    case 'documents':
      return cat === 'text' || cat === 'program-specific'
    case 'archive':
      return cat === 'archive'
    case 'other':
      return !['image', 'video', 'music', 'text', 'program-specific', 'archive'].includes(cat)
    default:
      return true
  }
}
