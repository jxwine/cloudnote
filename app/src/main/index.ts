import { app, shell, BrowserWindow, ipcMain, nativeTheme, dialog } from 'electron'
import { join, dirname } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'

/** 由构建注入：打包时没指定远程服务器才需要自带一份后端 */
declare const __USE_BUNDLED_SERVER__: boolean

const isDev = !app.isPackaged

// 开发时可以挂调试端口，方便自动化驱动真实窗口：
//   CLOUDNOTE_DEBUG_PORT=9444 npm run dev
if (isDev && process.env.CLOUDNOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.CLOUDNOTE_DEBUG_PORT)
}
let mainWindow: BrowserWindow | null = null
let serverProc: ChildProcess | null = null

/**
 * 系统窗口按钮所在的那条 overlay 由主进程绘制，颜色必须和渲染进程标题栏的
 * --bg / --text-2 完全一致，否则右上角会割出一块颜色不同的方块。
 * 数值取自 renderer/src/styles/app.css，改那边时这里要跟着改。
 */
const overlayFor = (dark: boolean) => ({
  color: dark ? '#17181b' : '#f1f2f0', // --bg
  symbolColor: dark ? '#9b9da3' : '#6b6d77', // --text-2
  height: 40, // --titlebar-h
})

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 860,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: dark ? '#17181b' : '#f1f2f0', // 同 --bg，避免加载瞬间闪白
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayFor(dark),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      spellcheck: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 兜底：渲染进程迟迟没有首帧（dev server 未就绪、页面报错）时也要把窗口显示出来，
  // 否则进程活着却看不到任何界面，无从排查
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  }, 4000)

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[主进程] 页面加载失败 ${code} ${desc} ${url}`)
  })

  // 外部链接交给系统浏览器，不在应用内打开。
  // 这里再校验一次协议：渲染进程已经挡过一道，但这是通往系统的最后一关
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    mainWindow?.setTitleBarOverlay?.(overlayFor(isDark))
    mainWindow?.webContents.send('theme:changed', isDark ? 'dark' : 'light')
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 打包版自带同步服务：跟随应用启动本地 server，
 * 用户不配置远程地址时也能开箱即用（数据落在 userData 目录）。
 * 打包时指定了 VITE_CLOUDNOTE_SERVER 的话不会走到这里。
 */
function startBundledServer(): void {
  const entry = join(process.resourcesPath, 'server', 'src', 'index.js')
  if (!existsSync(entry)) return
  serverProc = fork(entry, {
    env: {
      ...process.env,
      PORT: process.env.PORT || '4471',
      HOST: '127.0.0.1',
      CLOUDNOTE_DB: join(app.getPath('userData'), 'cloudnote.db'),
    },
    stdio: 'ignore',
  })
}

app.whenReady().then(() => {
  if (!isDev && __USE_BUNDLED_SERVER__) startBundledServer()

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  }))

  /** 导出单篇：弹保存对话框 */
  ipcMain.handle('export:file', async (_e, name: string, content: string) => {
    if (!mainWindow) return { ok: false }
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出笔记',
      defaultPath: join(app.getPath('documents'), name),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false }
    writeFileSync(res.filePath, content, 'utf8')
    return { ok: true, path: res.filePath }
  })

  /** 批量导出：选个目录，按笔记原来的目录结构铺开写进去 */
  ipcMain.handle(
    'export:folder',
    async (_e, files: { path: string; content: string }[]) => {
      if (!mainWindow) return { ok: false }
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择导出位置',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (res.canceled || !res.filePaths[0]) return { ok: false }

      const root = join(res.filePaths[0], `云笔记导出-${new Date().toISOString().slice(0, 10)}`)
      for (const file of files) {
        const full = join(root, file.path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, file.content, 'utf8')
      }
      return { ok: true, path: root, count: files.length }
    }
  )

  /** 导出完在文件管理器里定位到它 */
  ipcMain.handle('shell:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('theme:set', (_e, mode: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = mode
    const isDark = nativeTheme.shouldUseDarkColors
    mainWindow?.setTitleBarOverlay?.(overlayFor(isDark))
    return isDark ? 'dark' : 'light'
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  serverProc?.kill()
})
