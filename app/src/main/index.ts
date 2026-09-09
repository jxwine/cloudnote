import { app, shell, BrowserWindow, ipcMain, nativeTheme, dialog, Tray, Menu, net } from 'electron'
import { join, dirname, basename } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync, createWriteStream, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
let tray: Tray | null = null
/** 真要退出了。关窗按钮会被拦下来改成隐藏，只有这个标记为真时才放行 */
let quitting = false
/** 第一次收进托盘时提示一下，否则用户会以为程序被自己关掉了 */
let hintShown = false

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

  // 点关闭不退出，收进托盘。真正退出走托盘菜单的「退出」，那条路会先把 quitting 置真。
  // 托盘没建起来时不拦——否则窗口关不掉，用户只能去任务管理器。
  mainWindow.on('close', (e) => {
    if (quitting || !tray) return
    e.preventDefault()
    mainWindow?.hide()
    if (!hintShown && process.platform === 'win32') {
      hintShown = true
      tray.displayBalloon({
        title: '云笔记还在后台',
        content: '窗口已收进托盘，点这里的图标可以随时打开。要彻底退出请右键图标选「退出」。',
      })
    }
  })

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

/** 把窗口叫回前台：可能是隐藏了，也可能只是被压在别的窗口下面 */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/**
 * 系统托盘。
 *
 * 图标用 build/tray.png，Electron 会自动认 tray@2x.png 那份高分屏的。
 * 路径相对 __dirname 取，dev 下是 app/out/main，打包后是 app.asar/out/main，
 * 往上两级都能落到 build/，所以两边同一行代码。
 */
function createTray(): void {
  const icon = join(__dirname, '../../build/tray.png')
  if (!existsSync(icon)) {
    console.error('[主进程] 托盘图标缺失，跳过托盘：' + icon)
    return
  }

  tray = new Tray(icon)
  tray.setToolTip('云笔记')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开云笔记', click: showWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ])
  )
  // Windows 上单击图标就该把窗口叫回来，不用去翻右键菜单
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
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

/**
 * 只允许跑一个实例。
 *
 * 窗口收进托盘之后，用户很容易以为程序已经关了，又去点一次快捷方式。
 * 没有这道锁就会起第二个实例——打包版还会再 fork 一个本地服务去抢 4471 端口。
 * 后来的那个实例直接退出，把已有窗口叫到前台就行。
 */
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()
else app.on('second-instance', showWindow)

app.whenReady().then(() => {
  if (!isPrimaryInstance) return
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

  /**
   * 下载安装包。
   *
   * 放在主进程而不是渲染进程：渲染进程拿不到文件系统，下完也没法交给系统去执行。
   * 边下边算 sha256，对不上就把文件删掉再报错——宁可让用户重来一次，
   * 也不能把一个来路不明的 exe 递给他去双击。
   */
  ipcMain.handle('update:download', async (_e, url: string, sha256: string) => {
    /*
     * 必须用 Electron 的 net.fetch，不能用 Node 内置的 fetch。
     *
     * 后者走 undici，不认 Windows 的系统代理，也不读系统证书库。装了代理软件的机器上
     * 它会直连一个被劫持的地址，报一句没头没脑的「fetch failed」——而渲染进程走的是
     * Chromium 网络栈，同一个域名好好的，于是「版本信息拿得到、包下不下来」。
     * net.fetch 用的就是 Chromium 那一套，和渲染进程行为一致。
     */
    let res: Response
    try {
      res = await net.fetch(url)
    } catch (err) {
      throw new Error(`连不上服务器：${err instanceof Error ? err.message : '未知错误'}`)
    }
    if (!res.ok || !res.body) throw new Error(`下载失败（${res.status}）`)

    const total = Number(res.headers.get('content-length') || 0)
    // URL 里的中文是百分号编码的，不解码的话临时文件名会是一串 %E4%BA%91，
    // 用户在 UAC 提示里看到的就是那串乱码。顺手去掉路径分隔符，防止拼出目录。
    const raw = decodeURIComponent(basename(new URL(url).pathname))
    const name = raw.replace(/[\/:*?"<>|]/g, '_') || 'cloudnote-setup.exe'
    const file = join(app.getPath('temp'), name)
    const hash = createHash('sha256')
    let received = 0

    try {
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        async function* (source) {
          for await (const chunk of source) {
            received += (chunk as Buffer).length
            hash.update(chunk as Buffer)
            mainWindow?.webContents.send('update:progress', { received, total })
            yield chunk
          }
        },
        createWriteStream(file)
      )
    } catch (err) {
      rmSync(file, { force: true })
      throw err
    }

    if (hash.digest('hex') !== sha256) {
      rmSync(file, { force: true })
      throw new Error('安装包校验失败，可能在传输中损坏了，请重试')
    }
    return file
  })

  /**
   * 拉起安装程序然后退出自己。
   *
   * NSIS 装的时候会要求覆盖正在运行的程序，所以必须先退。quitting 置真是为了
   * 绕过托盘那条「点关闭只隐藏」的拦截，否则这里 quit 不掉。
   */
  ipcMain.handle('update:install', async (_e, path: string) => {
    if (!existsSync(path)) throw new Error('安装包不见了，请重新下载')
    await shell.openPath(path)
    quitting = true
    // 给系统一点时间把安装程序拉起来，立刻退出的话有概率还没启动就没了父进程
    setTimeout(() => app.quit(), 800)
  })

  ipcMain.handle('theme:set', (_e, mode: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = mode
    const isDark = nativeTheme.shouldUseDarkColors
    mainWindow?.setTitleBarOverlay?.(overlayFor(isDark))
    return isDark ? 'dark' : 'light'
  })

  createTray()
  createWindow()

  app.on('activate', showWindow)
})

app.on('window-all-closed', () => {
  // 有托盘时窗口是被隐藏而不是关闭，这个事件基本不会触发；
  // 真触发了说明是退出流程走到这儿了，照常收尾。
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  serverProc?.kill()
  tray?.destroy()
  tray = null
})
