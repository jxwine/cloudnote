import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { resolveTheme, useStore, useBindings, currentBindings } from '@/lib/store'
import { comboFromEvent, findShortcut, formatCombo } from '@/lib/shortcuts'
import * as sync from '@/lib/sync'
import { LoginView } from './components/LoginView'
import { Sidebar } from './components/Sidebar'
import { EditorPane } from './components/Editor'
import { Outline } from './components/Outline'
import { SyncChip } from './components/SyncChip'
import { Toast } from './components/Toast'
import { PromptDialog } from './components/PromptDialog'
import { QuickJump } from './components/QuickJump'
import { SettingsDialog } from './components/SettingsDialog'
import { AuthExpiredDialog } from './components/AuthExpiredDialog'
import { UpdateDialog } from './components/UpdateDialog'
import { AdminApp } from './components/admin/AdminApp'
import { MobileShell } from './components/mobile/MobileShell'
import { useSyncLifecycle } from '@/lib/useSyncLifecycle'
import { desktop, isDesktop } from '@/lib/platform'
import { isTouch, watchViewport } from '@/lib/viewport'
import { checkUpdate, downloadClient, type UpdateInfo } from '@/lib/update'
import {
  IconCloud, IconPanelLeft, IconPanelRight, IconJump, IconTrash,
  IconServer, IconDownload, IconSettings,
} from './components/Icons'

export default function App() {
  const user = useStore((s) => s.user)
  const [route, setRoute] = useState(location.hash)

  useEffect(() => {
    const onHash = () => setRoute(location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useTheme()
  useViewportAttr()
  const viewport = useStore((s) => s.viewport)

  if (!user) return <LoginView />
  // 后台只在网页端开放：它是运维用的，浏览器里开就行，没必要占客户端的入口。
  // 非管理员就算手敲了 #/admin 也进不去；服务端接口另有一道 403，这里只是不给看界面。
  if (route === '#/admin' && user.isAdmin && !isDesktop) {
    return <AdminApp onExit={() => { location.hash = '' }} />
  }
  // 手机是另一套外壳：首页卡片 + 全屏编辑页，不是把三栏压扁。桌面端 viewport 恒为 desktop，永远走 Workspace
  if (viewport === 'phone') return <MobileShell route={route} />
  return <Workspace />
}

/**
 * 外观。放在 App 顶层而不是 Workspace 里，登录页才吃得到主题——
 * 之前那个 effect 在 Workspace 内，没登录时永远是浅色。
 *
 * themeMode 是用户记住的选择，theme 是当下实际生效的配色，两者分开：
 * 选了「跟随系统」时 theme 会跟着系统变，themeMode 始终是 system。
 */
function useTheme() {
  const themeMode = useStore((s) => s.themeMode)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const setThemeMode = useStore((s) => s.setThemeMode)
  /* 桌面端要先跟主进程对完账才能往回写，否则会拿本地的默认值把它盖掉 */
  const [synced, setSynced] = useState(!isDesktop)

  /*
   * 桌面端以主进程记的那份为准。
   *
   * 两边都存了一份：主进程写 settings.json（同步落盘，还负责冷启动第一帧的窗口底色），
   * 渲染进程写 localStorage。localStorage 是会丢的——清了站点数据、超了配额、
   * 进程被强杀时最后一次写入还没刷盘，都会让它退回默认值。让它去覆盖主进程，
   * 用户就会看到「窗口先是深色、渲染完又变回浅色」。所以启动时反过来，以主进程为准。
   */
  useEffect(() => {
    if (!desktop) return
    void desktop.info().then((info) => {
      setThemeMode(info.themeMode)
      setSynced(true)
    })
  }, [setThemeMode])

  useEffect(() => {
    if (!synced) return
    if (desktop) {
      // 交给主进程的 nativeTheme：它顺带把右上角那条系统窗口按钮也改了色，并把选择落盘
      void desktop.setTheme(themeMode).then(setTheme)
      // themeSource 被定成 light/dark 之后 shouldUseDarkColors 就固定了，
      // 系统再怎么变也不会串到这里来
      return desktop.onThemeChange(setTheme)
    }
    // 网页版没有主进程，自己听系统
    setTheme(resolveTheme(themeMode))
    if (themeMode !== 'system' || typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setTheme(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [synced, themeMode, setTheme])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    // 手机浏览器的地址栏 / PWA 状态栏跟着应用内的配色走，别亮色界面配一条深色地址栏
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((m) => { m.content = theme === 'dark' ? '#17181b' : '#f1f2f0' })
  }, [theme])

  // 排版设置挂成 CSS 变量，app.css 里 .ProseMirror 读它们；登录页没有编辑器，挂上也无妨
  const lineHeight = useStore((s) => s.lineHeight)
  const paragraphSpacing = useStore((s) => s.paragraphSpacing)
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--doc-line-height', String(lineHeight))
    root.setProperty('--doc-para-gap', `${paragraphSpacing}em`)
  }, [lineHeight, paragraphSpacing])
}

/**
 * 把屏幕档位挂到 <html data-viewport>，触屏再挂一个 data-touch。
 * 响应式样式全部以这两个属性做前缀；桌面端永远不挂，所以那些规则在 Electron 里一条都不生效。
 * 放在 App 顶层：登录页也要吃到（输入框 16px 防 iOS 聚焦缩放之类）。
 */
function useViewportAttr() {
  const setViewport = useStore((s) => s.setViewport)
  useEffect(() => {
    const root = document.documentElement
    if (isTouch) root.dataset.touch = ''
    return watchViewport((v) => {
      setViewport(v)
      if (v === 'desktop') delete root.dataset.viewport
      else root.dataset.viewport = v
    })
  }, [setViewport])
}

function Workspace() {
  const bindings = useBindings()
  const leftOpen = useStore((s) => s.leftOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  const leftWidth = useStore((s) => s.leftWidth)
  const rightWidth = useStore((s) => s.rightWidth)
  const activeNoteId = useStore((s) => s.activeNoteId)
  const user = useStore((s) => s.user)
  const sidebarView = useStore((s) => s.sidebarView)
  const setSidebarView = useStore((s) => s.setSidebarView)
  const trashCount = useStore((s) => Object.values(s.notes).filter((n) => n.deleted).length)
  const showToast = useStore((s) => s.showToast)
  const viewport = useStore((s) => s.viewport)
  const drawer = useStore((s) => s.drawer)
  const setDrawer = useStore((s) => s.setDrawer)

  /*
   * 平板上大纲是覆盖式抽屉（目录树留在原位）；桌面都不是。
   * 抽屉只看 drawer，不碰 rightOpen——那是桌面三栏的持久化偏好。
   */
  const rightAsDrawer = viewport === 'tablet'
  const leftShown = leftOpen
  const rightShown = rightAsDrawer ? drawer === 'right' : rightOpen

  /** 开合某一侧的唯一入口：抽屉侧改 drawer，其余走原来的 setPanel（带持久化） */
  const toggleSide = useCallback((side: 'left' | 'right', open?: boolean) => {
    const s = useStore.getState()
    if (side === 'right' && s.viewport === 'tablet') {
      const next = open ?? s.drawer !== 'right'
      s.setDrawer(next ? 'right' : null)
    } else {
      s.setPanel(side, open ?? !(side === 'left' ? s.leftOpen : s.rightOpen))
    }
  }, [])

  /* 回到桌面三栏时抽屉这个概念不存在，收掉，否则遮罩会一直挂着 */
  useEffect(() => {
    if (viewport === 'desktop') setDrawer(null)
  }, [viewport, setDrawer])

  const [editor, setEditor] = useState<Editor | null>(null)
  const [quickJump, setQuickJump] = useState(false)
  const [settings, setSettings] = useState(false)
  /** 正在弹的更新框；关掉就没了 */
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  /** 查到过的新版本，关掉弹窗也记着——设置里的版本号旁边靠它显示红点 */
  const [available, setAvailable] = useState<UpdateInfo | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const onEditorReady = useCallback((e: Editor | null) => setEditor(e), [])

  useSyncLifecycle()

  /* 快捷键：新建笔记、快速跳转、开合两侧栏。绑定表每次现取，改了设置立刻生效 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = findShortcut(currentBindings(), comboFromEvent(e))
      if (id === 'newNote') {
        e.preventDefault()
        void sync.createNote(null)
      } else if (id === 'quickJump') {
        e.preventDefault()
        setQuickJump(true)
      } else if (id === 'toggleLeft') {
        e.preventDefault()
        toggleSide('left')
      } else if (id === 'toggleRight') {
        e.preventDefault()
        toggleSide('right')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSide])

  /* 更新检查：登录后过 8 秒静默查一次，之后每 6 小时一次。
     查不到或者出错都不打扰用户——这个功能失败了不该弹窗。 */
  useEffect(() => {
    if (!isDesktop) return
    let alive = true
    const run = () =>
      void checkUpdate().then((info) => {
        if (!alive) return
        setAvailable(info)
        if (info) setUpdate(info)
      })
    const first = setTimeout(run, 8_000)
    const timer = setInterval(run, 6 * 60 * 60 * 1000)
    return () => {
      alive = false
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [])

  /** 设置里手动点的那次：查不到也要给个回应，不然像是没反应 */
  const manualCheck = async () => {
    const info = await checkUpdate()
    setAvailable(info)
    if (info) setUpdate(info)
    else showToast({ message: '已经是最新版本' })
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">
          <IconCloud size={15} className="brand-mark" />
          云笔记
        </span>

        <button
          className={'icon-btn' + (leftShown ? ' is-on' : '')}
          title={`目录栏 (${formatCombo(bindings.toggleLeft)})`}
          aria-pressed={leftShown}
          onClick={() => toggleSide('left')}
        >
          <IconPanelLeft />
        </button>
        <button
          className={'icon-btn' + (rightShown ? ' is-on' : '')}
          title={`大纲栏 (${formatCombo(bindings.toggleRight)})`}
          aria-pressed={rightShown}
          onClick={() => toggleSide('right')}
        >
          <IconPanelRight />
        </button>
        <button
          className={'icon-btn has-badge' + (sidebarView === 'trash' ? ' is-on' : '')}
          title={trashCount ? `回收站（${trashCount} 篇）` : '回收站'}
          aria-pressed={sidebarView === 'trash'}
          onClick={() => {
            // 再点一次退回笔记列表，当成一个开关用
            setSidebarView(sidebarView === 'trash' ? 'tree' : 'trash')
            if (!leftShown) toggleSide('left', true)
          }}
        >
          <IconTrash />
          {trashCount > 0 && <span className="badge">{trashCount > 99 ? '99+' : trashCount}</span>}
        </button>
        <button className="icon-btn" title={`快速跳转 (${formatCombo(bindings.quickJump)})`} onClick={() => setQuickJump(true)}>
          <IconJump />
        </button>
        {/* 下面两个只在网页版出现：客户端里下载自己没意义，后台是运维用的，浏览器开就行 */}
        {!isDesktop && (
          <button className="icon-btn" title="下载 Windows 客户端" onClick={() => void downloadClient()}>
            <IconDownload />
          </button>
        )}
        {!isDesktop && user?.isAdmin && (
          <button className="icon-btn" title="后台管理" onClick={() => { location.hash = '#/admin' }}>
            <IconServer />
          </button>
        )}

        <span className="titlebar-spacer" />

        <SyncChip />
        <button className="icon-btn" title="设置" onClick={() => setSettings(true)}>
          <IconSettings />
        </button>
        {/* 给系统的窗口按钮留出位置。网页版没有那三个按钮，留了就是一块空白 */}
        {isDesktop && <span style={{ width: 138, flex: '0 0 auto' }} />}
      </header>

      <div className="workspace">
        <aside
          className={'panel panel-left' + (leftShown ? '' : ' is-collapsed')}
          style={{ width: leftWidth }}
        >
          <Sidebar />
        </aside>
        {leftShown && <Resizer side="left" />}

        <EditorPane onEditorReady={onEditorReady} scrollRef={scrollRef} />

        {rightShown && !rightAsDrawer && <Resizer side="right" />}
        <aside
          className={'panel panel-right' + panelState(rightAsDrawer, rightShown)}
          style={rightAsDrawer ? undefined : { width: rightWidth }}
        >
          <div className="panel-head">
            <span className="panel-title">大纲</span>
          </div>
          <div className="panel-body">
            <Outline
              editor={editor}
              scrollRef={scrollRef}
              noteId={activeNoteId}
              onNavigate={rightAsDrawer ? () => setDrawer(null) : undefined}
            />
          </div>
        </aside>

        {/* 平板上大纲抽屉打开时压在编辑区上的遮罩，点一下收回 */}
        {rightAsDrawer && drawer === 'right' && (
          <div className="drawer-backdrop" onClick={() => setDrawer(null)} />
        )}
      </div>

      <Toast />
      <PromptDialog />
      {quickJump && <QuickJump onClose={() => setQuickJump(false)} />}
      {settings && (
        <SettingsDialog
          onClose={() => setSettings(false)}
          onCheckUpdate={() => void manualCheck()}
          newVersion={available?.version ?? null}
        />
      )}
      {update && <UpdateDialog info={update} onClose={() => setUpdate(null)} />}
      {/* 凭证失效的提示压在最上面：这时候任何编辑都传不上去，得先把话说清楚 */}
      <AuthExpiredDialog />
    </div>
  )
}

/** 大纲栏的开合类名：平板抽屉用 is-open 滑入滑出（is-collapsed 带 width:0 !important，抽屉不能沾它），
 *  原位面板用 is-collapsed 挤成零宽 */
const panelState = (asDrawer: boolean, shown: boolean) =>
  asDrawer ? (shown ? ' is-open' : '') : shown ? '' : ' is-collapsed'

/** 拖动改变侧栏宽度 */
function Resizer({ side }: { side: 'left' | 'right' }) {
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    setDragging(true)
    // 拖动期间把浮动格式条藏起来，免得跟着抖；松手后 BubbleToolbar 里的
    // ResizeObserver 会把它重新定位好
    document.body.classList.add('is-resizing')

    const move = (ev: PointerEvent) => {
      const width = side === 'left' ? ev.clientX : window.innerWidth - ev.clientX
      setPanelWidth(side, width)
    }
    const up = () => {
      setDragging(false)
      document.body.classList.remove('is-resizing')
      el.releasePointerCapture(e.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div
      className={'resizer' + (dragging ? ' is-dragging' : '')}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整目录栏宽度' : '调整大纲栏宽度'}
    />
  )
}
