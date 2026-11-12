import type { Note, Folder } from './types'
import { safeFileName } from './markdown'

export const EXPORT_FORMATS = [
  { id: 'md', label: 'Markdown', extension: '.md', description: '便于备份和继续编辑' },
  { id: 'docx', label: 'Word', extension: '.docx', description: '保留常用排版，适合编辑和分享' },
  { id: 'txt', label: '纯文本', extension: '.txt', description: '通用文本，适合复制和跨软件使用' },
] as const
export type ExportFormat = typeof EXPORT_FORMATS[number]['id']
export type ExportEntry = { note: Note; path: string }

export const EXPORT_MIME: Record<ExportFormat, string> = {
  md: 'text/markdown;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain;charset=utf-8',
}

/** Windows 文件名规则也用于网页与安卓，避免换设备后无法打开。 */
export function exportName(value: string): string {
  const name = safeFileName(value).replace(/[\u0000-\u001f]/g, '-').replace(/[. ]+$/, '') || '无标题'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name
}

/** 目录和文件统一去重；Windows 不区分大小写，清理后的同名目录也不能混在一起。 */
export function exportEntries(notes: Note[], folders: Record<string, Folder>, format: ExportFormat): ExportEntry[] {
  const used = new Set<string>()
  const directories = new Map<string, string>()
  const allocate = (parent: string, name: string, extension = '') => {
    const base = exportName(name)
    let candidate = '', i = 1
    do {
      const leaf = `${base}${i === 1 ? '' : ` (${i})`}${extension}`
      candidate = parent ? `${parent}/${leaf}` : leaf
      i++
    } while (used.has(candidate.toLowerCase()))
    used.add(candidate.toLowerCase())
    return candidate
  }
  const directory = (id: string | null, visiting = new Set<string>()): string => {
    if (!id || !folders[id] || visiting.has(id)) return ''
    if (directories.has(id)) return directories.get(id)!
    visiting.add(id)
    const folder = folders[id]
    const path = allocate(directory(folder.parentId, visiting), folder.name)
    directories.set(id, path)
    return path
  }
  notes.forEach((note) => directory(note.folderId))
  return notes.map((note) => ({ note, path: allocate(directory(note.folderId), note.title, `.${format}`) }))
}

/** 用 DOM 遍历保留文本分段；不能用 Markdown 去符号，否则代码与普通文字会被误删。 */
export function noteToText(note: Note): string {
  const doc = new DOMParser().parseFromString(note.content || '', 'text/html')
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const el = node as HTMLElement
    const children = () => Array.from(el.childNodes).map(text).join('')
    switch (el.tagName) {
      case 'SCRIPT': case 'STYLE': case 'LABEL': return ''
      case 'BR': return '\n'
      case 'IMG': return `[图片：${el.getAttribute('alt') || '图片'}]${el.getAttribute('src') || ''}`
      case 'A': {
        const label = children(), href = el.getAttribute('href') || ''
        return href && href !== label ? `${label} (${href})` : label
      }
      case 'UL': case 'OL':
        return Array.from(el.children).map((item, i) => {
          const marker = el.getAttribute('data-type') === 'taskList'
            ? (item.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ')
            : el.tagName === 'OL' ? `${Number(el.getAttribute('start') || 1) + i}. ` : '• '
          return marker + text(item).trim()
        }).join('\n') + '\n\n'
      case 'TD': case 'TH': return children().trim() + '\t'
      case 'TR': return children().trimEnd() + '\n'
      case 'PRE': return (el.textContent || '') + '\n\n'
      case 'P': case 'DIV': case 'BLOCKQUOTE': case 'TABLE':
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return children() + '\n\n'
      case 'HR': return '\n────────\n'
      default: return children()
    }
  }
  const body = Array.from(doc.body.childNodes).map(text).join('').replace(/\n{3,}/g, '\n\n').trim()
  const title = note.title.trim() || '无标题'
  const tags = note.tags?.length ? `标签：${note.tags.join('、')}\n\n` : ''
  return `${title}\n\n${tags}${body}\n`
}
