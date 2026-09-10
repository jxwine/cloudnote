import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { resolveTheme, useStore } from '@/lib/store'
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
import { desktop, isDesktop } from '@/lib/platform'
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

  if (!user) return <LoginView />
  // 后台只在网页端开放：它是运维用的，浏览器里开就行，没必要占客户端的入口。
  // 非管理员就算手敲了 #/admin 也进不去；服务端接口另有一道 403，这里只是不给看界面。
  if (route === '#/admin' && user.isAdmin && !isDesktop) {
    return <AdminApp onExit={() => { location.hash = '' }} />
  }
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
  }, [theme])
}

function Workspace() {
  const leftOpen = useStore((s) => s.leftOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  const leftWidth = useStore((s) => s.leftWidth)
  const rightWidth = useStore((s) => s.rightWidth)
  const setPanel = useStore((s) => s.setPanel)
  const activeNoteId = useStore((s) => s.activeNoteId)
  const user = useStore((s) => s.user)
  const sidebarView = useStore((s) => s.sidebarView)
  const setSidebarView = useStore((s) => s.setSidebarView)
  const trashCount = useStore((s) => Object.values(s.notes).filter((n) => n.deleted).length)
  const showToast = useStore((s) => s.showToast)

  const [editor, setEditor] = useState<Editor | null>(null)
  const [quickJump, setQuickJump] = useState(false)
  const [settings, setSettings] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const onEditorReady = useCallback((e: Editor | null) => setEditor(e), [])

  /* 启动同步；窗口重新获得焦点时补一次增量拉取，防止睡眠期间漏消息 */
  useEffect(() => {
    sync.start()
    // 用 syncNow 而不是裸的 pullDelta：必须先把本地攒着的改动送出去再拉远端，
    // 否则合盖再打开这一下就会把别的设备刚写的内容静默盖掉
    const onFocus = () => void sync.syncNow()
    const onOnline = () => {
      sync.stop()
      sync.start()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      sync.stop()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  /* 快捷键：新建笔记、快速跳转、开合两侧栏 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        void sync.createNote(null)
      } else if (k === 'p' && !e.shiftKey) {
        e.preventDefault()
        setQuickJump(true)
      } else if (k === '\\') {
        e.preventDefault()
        setPanel('left', !useStore.getState().leftOpen)
      } else if (k === '/' && e.shiftKey) {
        e.preventDefault()
        setPanel('right', !useStore.getState().rightOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPanel])

  /* 更新检查：登录后过 8 秒静默查一次，之后每 6 小时一次。
     查不到或者出错都不打扰用户——这个功能失败了不该弹窗。 */
  useEffect(() => {
    if (!isDesktop) return
    let alive = true
    const run = () =>
      void checkUpdate().then((info) => {
        if (alive && info) setUpdate(info)
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
          className={'icon-btn' + (leftOpen ? ' is-on' : '')}
          title="目录栏 (Ctrl+\)"
          aria-pressed={leftOpen}
          onClick={() => setPanel('left', !leftOpen)}
        >
          <IconPanelLeft />
        </button>
        <button
          className={'icon-btn' + (rightOpen ? ' is-on' : '')}
          title="大纲栏 (Ctrl+Shift+/)"
          aria-pressed={rightOpen}
          onClick={() => setPanel('right', !rightOpen)}
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
            if (!leftOpen) setPanel('left', true)
          }}
        >
          <IconTrash />
          {trashCount > 0 && <span className="badge">{trashCount > 99 ? '99+' : trashCount}</span>}
        </button>
        <button className="icon-btn" title="快速跳转 (Ctrl+P)" onClick={() => setQuickJump(true)}>
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
          className={'panel panel-left' + (leftOpen ? '' : ' is-collapsed')}
          style={{ width: leftWidth }}
        >
          <Sidebar />
        </aside>
        {leftOpen && <Resizer side="left" />}

        <EditorPane onEditorReady={onEditorReady} scrollRef={scrollRef} />

        {rightOpen && <Resizer side="right" />}
        <aside
          className={'panel panel-right' + (rightOpen ? '' : ' is-collapsed')}
          style={{ width: rightWidth }}
        >
          <div className="panel-head">
            <span className="panel-title">大纲</span>
          </div>
          <div className="panel-body">
            <Outline editor={editor} scrollRef={scrollRef} noteId={activeNoteId} />
          </div>
        </aside>
      </div>

      <Toast />
      <PromptDialog />
      {quickJump && <QuickJump onClose={() => setQuickJump(false)} />}
      {settings && (
        <SettingsDialog onClose={() => setSettings(false)} onCheckUpdate={() => void manualCheck()} />
      )}
      {update && <UpdateDialog info={update} onClose={() => setUpdate(null)} />}
      {/* 凭证失效的提示压在最上面：这时候任何编辑都传不上去，得先把话说清楚 */}
      <AuthExpiredDialog />
    </div>
  )
}

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
