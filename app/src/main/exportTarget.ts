import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep, win32 } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'

type ExportFile = { path: string; content: string | Uint8Array }
type Selection = { sender: WebContents; ticket?: string; path?: string; bulk: boolean }

function fileContent(value: unknown): value is ExportFile['content'] {
  return typeof value === 'string' || value instanceof Uint8Array
}

/** 同时按 Windows 与 POSIX 规则检查，避免反斜杠、盘符及替代数据流绕过检查。 */
function relativeFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value || win32.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new Error('导出文件路径无效')
  }
  const parts = value.replace(/\\/g, '/').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f<>:"|?*]/.test(part) ||
    /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('导出文件路径无效')
  }
  return parts.join('/')
}

/**
 * 选择位置与写入分成两步。原生对话框关闭后，渲染进程先重新检查账号和阅读权限，
 * 再凭一次性票据写入；未确认、取消及权限变化都不会提前创建导出文件。
 */
export function registerExportTargets(getWindow: () => BrowserWindow | null): void {
  let selection: Selection | null = null
  const observed = new WeakSet<WebContents>()
  const ownWindow = (event: IpcMainInvokeEvent): BrowserWindow | null => {
    const window = getWindow()
    return window && !window.isDestroyed() && !event.sender.isDestroyed() && window.webContents === event.sender
      ? window : null
  }

  ipcMain.handle('export:choose-target', async (event, name: string, bulk: boolean) => {
    const window = ownWindow(event)
    if (!window) return null
    // 请求一开始就使前一张票据失效；并发打开的旧对话框也不能发出新票据。
    const pending: Selection = { sender: event.sender, bulk: !!bulk }
    selection = pending
    if (!observed.has(event.sender)) {
      const sender = event.sender
      observed.add(sender)
      sender.once('destroyed', () => {
        if (selection?.sender === sender) selection = null
      })
    }
    let selectedPath: string | undefined
    if (bulk) {
      const result = await dialog.showOpenDialog(window, {
        title: '选择导出位置', properties: ['openDirectory', 'createDirectory'],
      })
      if (!result.canceled) selectedPath = result.filePaths[0]
    } else {
      const safeName = relativeFilePath(name)
      if (safeName.includes('/')) throw new Error('导出文件名无效')
      const lowerName = safeName.toLowerCase()
      const format = lowerName.endsWith('.docx') ? { name: 'Word 文档', extensions: ['docx'] }
        : lowerName.endsWith('.txt') ? { name: '纯文本', extensions: ['txt'] }
        : { name: 'Markdown', extensions: ['md'] }
      const result = await dialog.showSaveDialog(window, {
        title: '导出笔记', defaultPath: join(app.getPath('documents'), safeName), filters: [format],
      })
      if (!result.canceled) selectedPath = result.filePath
    }
    if (selection !== pending || !ownWindow(event) || !selectedPath) return null
    pending.path = resolve(selectedPath)
    pending.ticket = randomUUID()
    return { ticket: pending.ticket, path: pending.path }
  })

  ipcMain.handle('export:write-target', (event, ticket: string, files: ExportFile[]) => {
    const target = selection
    if (!ownWindow(event) || !target?.ticket || ticket !== target.ticket || target.sender !== event.sender || !target.path) {
      throw new Error('导出位置已失效，请重新导出')
    }
    selection = null // 一次性消费，验证或写入失败后也不能重放。
    if (!Array.isArray(files) || !files.length || files.some((file) => !file || !fileContent(file.content))) {
      throw new Error('导出内容无效')
    }
    if (!target.bulk) {
      if (files.length !== 1) throw new Error('单篇导出只能写入一个文件')
      // 文件路径只认用户选择的目标，不接受渲染进程在写入阶段更换路径。
      writeFileSync(target.path, typeof files[0].content === 'string' ? files[0].content : Buffer.from(files[0].content), 'utf8')
      return { ok: true, path: target.path }
    }

    // 所有校验均在创建目录之前完成，错误路径不会留下半份导出。
    const paths = files.map((file) => relativeFilePath(file.path))
    const names = new Set(paths.map((path) => path.toLowerCase()))
    if (names.size !== paths.length) throw new Error('导出文件路径重复')
    for (const path of paths) {
      const parts = path.toLowerCase().split('/')
      for (let i = 1; i < parts.length; i++) {
        if (names.has(parts.slice(0, i).join('/'))) throw new Error('导出文件与目录重名')
      }
    }
    const root = mkdtempSync(join(target.path, `云笔记导出-${new Date().toISOString().slice(0, 10)}-`))
    for (let i = 0; i < files.length; i++) {
      const full = resolve(root, paths[i])
      if (!full.startsWith(resolve(root) + sep)) throw new Error('导出文件路径超出目录')
      mkdirSync(dirname(full), { recursive: true })
      const content = files[i].content
      writeFileSync(full, typeof content === 'string' ? content : Buffer.from(content), { encoding: 'utf8', flag: 'wx' })
    }
    return { ok: true, path: root, count: files.length }
  })
}
