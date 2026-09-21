import { htmlToMarkdown, noteToMarkdownFile, safeFileName } from './markdown'
import { folderPath } from './search'
import { useStore } from './store'
import type { Folder, Note } from './types'
import { isDesktop, desktop, isNative } from './platform'

/**
 * 浏览器里没有 Electron 的保存对话框，退回到普通下载。
 * 安卓壳的 WebView 下不了 blob:，改走系统分享（Web Share API 带文件），
 * 用户自己挑存到网盘、发到微信还是「保存到文件」。
 */
function browserDownload(name: string, content: string) {
  if (isNative) {
    void nativeShare(name, content)
    return
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 安卓壳：先把文件写进 App 的缓存目录，再拉起系统分享面板。
 * 插件走 window.Capacitor.Plugins 的全局，不 import @capacitor/*——那些包只装在 android/ 里，
 * 网页版 / 桌面端的构建不该为它多一个依赖。
 */
async function nativeShare(name: string, content: string) {
  const plugins = window.Capacitor?.Plugins
  const store = useStore.getState()
  if (!plugins?.Filesystem || !plugins?.Share) {
    store.showToast({ message: '这个版本的安卓端还不支持导出' })
    return
  }
  try {
    const { uri } = await plugins.Filesystem.writeFile({
      path: `export/${name}`,
      data: content,
      directory: 'CACHE',
      encoding: 'utf8',
      recursive: true,
    })
    // 用户取消分享会 reject，不算错
    await plugins.Share.share({ title: name, files: [uri] }).catch(() => {})
  } catch (e) {
    store.showToast({ message: '导出失败：' + (e instanceof Error ? e.message : String(e)) })
  }
}

/** 导出单篇 */
export async function exportNote(note: Note) {
  const name = `${safeFileName(note.title)}.md`
  const content = noteToMarkdownFile(note)
  const store = useStore.getState()

  if (!isDesktop) {
    browserDownload(name, content)
    return
  }
  const res = await desktop!.exportFile(name, content)
  if (!res.ok) return
  store.showToast({
    message: `已导出到 ${res.path}`,
    actionLabel: '打开位置',
    onAction: () => void desktop?.reveal(res.path!),
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

  if (!isDesktop) {
    // 浏览器里逐个下载不现实，合成一个文件
    browserDownload(
      '云笔记导出.md',
      files.map((f) => `<!-- ${f.path} -->\n\n${f.content}`).join('\n\n---\n\n')
    )
    return
  }

  const res = await desktop!.exportFolder(files)
  if (!res.ok) return
  showToast({
    message: `已导出 ${res.count} 篇到 ${res.path}`,
    actionLabel: '打开位置',
    onAction: () => void desktop?.reveal(res.path!),
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
