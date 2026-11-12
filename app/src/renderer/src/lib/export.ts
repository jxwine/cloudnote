import { htmlToMarkdown, noteToMarkdownFile } from './markdown'
import { useStore } from './store'
import type { Folder, Note } from './types'
import { isDesktop, desktop, isNative } from './platform'
import { blockedLock, canReadNote, lockChain, lockKey, getReadingLock } from './readingLock'
import { chooseExportFormat } from './exportDialog'
import { exportEntries, exportName, EXPORT_MIME, noteToText, type ExportEntry, type ExportFormat } from './exportFormats'
import { getAccountEpoch } from './accountStorage'
import { prepareForExport } from './sync'

type Content = string | Uint8Array
type File = { path: string; content: Content }
let exporting = false

function browserDownload(name: string, content: Content, format: ExportFormat) {
  const part = typeof content === 'string' ? content : new Uint8Array(content).buffer
  const url = URL.createObjectURL(new Blob([part], { type: EXPORT_MIME[format] }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function nativeShare(name: string, content: Content, validate: () => void) {
  const plugins = window.Capacitor?.Plugins
  if (!plugins?.Filesystem || !plugins?.Share) throw new Error('这个版本的安卓端还不支持导出，请升级安卓端')
  let data: string
  if (typeof content === 'string') data = content
  else {
    data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('无法读取 Word 文件'))
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.readAsDataURL(new Blob([new Uint8Array(content).buffer]))
    })
  }
  validate()
  const { uri } = await plugins.Filesystem.writeFile({
    path: `export/${Date.now()}-${name}`, data, directory: 'CACHE',
    // 不传 encoding 才会按 base64 写二进制。
    ...(typeof content === 'string' ? { encoding: 'utf8' } : {}), recursive: true,
  })
  validate()
  try { await plugins.Share.share({ title: name, files: [uri] }) }
  catch (error) {
    if (!/cancel|dismiss|取消/i.test(error instanceof Error ? error.message : String(error))) throw error
  }
}

async function convert(entries: ExportEntry[], format: ExportFormat, bulk = false): Promise<Content> {
  if (format === 'docx') {
    const { notesToWord } = await import('./word')
    return notesToWord(bulk ? entries : entries.map(({ note }) => ({ note })))
  }
  const convertNote = format === 'md' ? noteToMarkdownFile : noteToText
  const content = !bulk ? convertNote(entries[0].note)
    : entries.map(({ note, path }) => `${format === 'md' ? `<!-- ${path} -->` : `目录：${path}`}\n\n${convertNote(note)}`)
      .join(format === 'md' ? '\n\n---\n\n' : '\n\n────────────\n\n')
  // UTF-8 BOM 让旧版 Windows 记事本也能识别中文。
  return format === 'txt' ? '\uFEFF' + content : content
}

async function save(entries: ExportEntry[], format: ExportFormat, bulk: boolean, validate: (afterNativeDialog?: boolean) => void) {
  const canSaveDesktop = isDesktop && (format === 'md' || desktop?.exportBinary === true)
  const saveDesktop = async (name: string, files: File[]) => {
    let res: { ok: boolean; path?: string; count?: number }
    if (desktop?.chooseExportTarget && desktop.writeExportTarget) {
      validate()
      const target = await desktop.chooseExportTarget(name, bulk)
      if (!target) return
      // 原生对话框会触发失焦并清除界面解锁。只延续打开它前已确认的这次导出，
      // 不恢复解锁状态；账号、笔记存续和锁链修订仍须在写入前重新验证。
      validate(true)
      res = await desktop.writeExportTarget(target.ticket, files)
    } else {
      validate()
      res = bulk ? await desktop!.exportFolder(files) : await desktop!.exportFile(name, files[0].content)
    }
    if (res.ok) useStore.getState().showToast({
      message: bulk ? `已导出 ${res.count} 篇到 ${res.path}` : `已导出到 ${res.path}`,
      actionLabel: '打开位置', onAction: () => void desktop?.reveal(res.path!),
    })
  }
  if (canSaveDesktop && bulk) {
    const files: File[] = []
    for (const entry of entries) {
      validate()
      files.push({ path: entry.path, content: await convert([entry], format) })
    }
    validate()
    await saveDesktop(`云笔记导出.${format}`, files)
    return
  }
  const name = bulk ? `云笔记导出.${format}` : `${exportName(entries[0].note.title)}.${format}`
  const content = await convert(entries, format, bulk)
  validate()
  if (canSaveDesktop) {
    await saveDesktop(name, [{ path: name, content }])
  } else if (isNative) await nativeShare(name, content, validate)
  else browserDownload(name, content, format)
}

async function runExport(title: string, bulk: boolean, select: () => Note[]) {
  if (exporting) return
  exporting = true
  const epoch = getAccountEpoch()
  const user = useStore.getState().user?.id
  try {
    select()
    const format = await chooseExportFormat(title, bulk)
    if (!format) return
    if (epoch !== getAccountEpoch() || user !== useStore.getState().user?.id) return
    prepareForExport()
    const notes = select()
    const state = useStore.getState()
    const signature = (current: typeof state, id: string) => JSON.stringify(
      lockChain(current, { kind: 'note', id }).map((target) => [lockKey(target), getReadingLock(current, target)?.revision])
    )
    const signatures = new Map(notes.map((note) => [note.id, signature(state, note.id)]))
    const validate = (afterNativeDialog = false) => {
      const current = useStore.getState()
      if (epoch !== getAccountEpoch() || user !== current.user?.id ||
        notes.some((note) => !current.notes[note.id] || current.notes[note.id].deleted ||
          signature(current, note.id) !== signatures.get(note.id) ||
          (!afterNativeDialog && !canReadNote(current, current.notes[note.id])))) {
        throw new Error('账号或阅读权限已变化，请重新导出')
      }
    }
    await save(exportEntries(notes, state.folders, format), format, bulk, validate)
  } catch (error) {
    if (epoch === getAccountEpoch() && user === useStore.getState().user?.id) {
      useStore.getState().showToast({ message: '导出失败：' + (error instanceof Error ? error.message : String(error)) })
    }
  } finally { exporting = false }
}

export async function exportNote(note: Note) {
  return runExport('导出', false, () => {
    const store = useStore.getState()
    const current = store.notes[note.id]
    if (!current || current.deleted || !canReadNote(store, current)) throw new Error('请先解锁笔记及所在目录，再导出')
    return [current]
  })
}

export async function exportAll(opts: { folderId?: string | null } = {}) {
  return runExport(opts.folderId ? '导出这个目录' : '全部导出', true, () => {
    const store = useStore.getState()
    const all = Object.values(store.notes).filter((n) => !n.deleted)
    const scoped = opts.folderId === undefined ? all : all.filter((n) => inFolderTree(n, opts.folderId!, store.folders))
    if (opts.folderId && (!store.folders[opts.folderId] || store.folders[opts.folderId].deleted)) throw new Error('目录已删除，请重新选择')
    if ((opts.folderId && blockedLock(store, { kind: 'folder', id: opts.folderId })) || scoped.some((n) => !canReadNote(store, n))) {
      throw new Error('导出范围包含锁定的笔记或目录，请全部解锁后再导出')
    }
    if (!scoped.length) throw new Error('没有可导出的笔记')
    return scoped
  })
}

function inFolderTree(note: Note, rootId: string | null, folders: Record<string, Folder>): boolean {
  if (rootId === null) return note.folderId === null
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
