import { htmlToMarkdown, noteToMarkdownFile, safeFileName } from './markdown'
import { folderPath } from './search'
import { useStore } from './store'
import type { Folder, Note } from './types'

/** 浏览器里没有 Electron 的保存对话框，退回到普通下载 */
function browserDownload(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 导出单篇 */
export async function exportNote(note: Note) {
  const name = `${safeFileName(note.title)}.md`
  const content = noteToMarkdownFile(note)
  const store = useStore.getState()

  if (!window.cloudnote) {
    browserDownload(name, content)
    return
  }
  const res = await window.cloudnote.exportFile(name, content)
  if (!res.ok) return
  store.showToast({
    message: `已导出到 ${res.path}`,
    actionLabel: '打开位置',
    onAction: () => void window.cloudnote?.reveal(res.path!),
  })
}

/**
 * 导出全部（可按目录筛）。文件按笔记原来的目录层级铺开，
 * 同名笔记加序号，不至于互相覆盖。
 */
export async function exportAll(opts: { folderId?: string | null } = {}) {
  const { notes, folders, showToast } = useStore.getState()
  const all = Object.values(notes).filter((n) => !n.deleted)
  const scoped =
    opts.folderId === undefined ? all : all.filter((n) => inFolderTree(n, opts.folderId!, folders))

  if (!scoped.length) {
    showToast({ message: '没有可导出的笔记' })
    return
  }

  const used = new Set<string>()
  const files = scoped.map((note) => {
    const dir = folderPath(note.folderId, folders).map(safeFileName).join('/')
    let name = safeFileName(note.title)
    let path = dir ? `${dir}/${name}.md` : `${name}.md`
    // 同一目录下重名就加序号
    let i = 2
    while (used.has(path)) {
      name = `${safeFileName(note.title)} (${i++})`
      path = dir ? `${dir}/${name}.md` : `${name}.md`
    }
    used.add(path)
    return { path, content: noteToMarkdownFile(note) }
  })

  if (!window.cloudnote) {
    // 浏览器里逐个下载不现实，合成一个文件
    browserDownload(
      '云笔记导出.md',
      files.map((f) => `<!-- ${f.path} -->\n\n${f.content}`).join('\n\n---\n\n')
    )
    return
  }

  const res = await window.cloudnote.exportFolder(files)
  if (!res.ok) return
  showToast({
    message: `已导出 ${res.count} 篇到 ${res.path}`,
    actionLabel: '打开位置',
    onAction: () => void window.cloudnote?.reveal(res.path!),
  })
}

function inFolderTree(note: Note, rootId: string, folders: Record<string, Folder>): boolean {
  let cursor = note.folderId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    if (cursor === rootId) return true
    seen.add(cursor)
    cursor = folders[cursor]?.parentId ?? null
  }
  return false
}

export { htmlToMarkdown }
