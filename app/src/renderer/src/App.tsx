import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { useStore } from '@/lib/store'
import { session } from '@/lib/api'
import * as sync from '@/lib/sync'
import { LoginView } from './components/LoginView'
import { Sidebar } from './components/Sidebar'
import { EditorPane } from './components/Editor'
import { Outline } from './components/Outline'
import { SyncChip } from './components/SyncChip'
import { Toast } from './components/Toast'
import { PromptDialog } from './components/PromptDialog'
import { QuickJump } from './components/QuickJump'
import { PasswordDialog } from './components/PasswordDialog'
import { exportAll } from '@/lib/export'
import { useContextMenu, type MenuAction } from './components/ContextMenu'
import {
  IconCloud, IconPanelLeft, IconPanelRight, IconPlus,
  IconMoon, IconSun, IconLogout, IconMore, IconKey, IconExport, IconJump, IconTrash,
} from './components/Icons'

export default function App() {
  const user = useStore((s) => s.user)
  return user ? <Workspace /> : <LoginView />
}

function Workspace() {
  const leftOpen = useStore((s) => s.leftOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  const leftWidth = useStore((s) => s.leftWidth)
  const rightWidth = useStore((s) => s.rightWidth)
  const setPanel = useStore((s) => s.setPanel)
  const activeNoteId = useStore((s) => s.activeNoteId)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const user = useStore((s) => s.user)
  const reset = useStore((s) => s.reset)
  const sidebarView = useStore((s) => s.sidebarView)
  const setSidebarView = useStore((s) => s.setSidebarView)
  const trashCount = useStore((s) => Object.values(s.notes).filter((n) => n.deleted).length)

  const [editor, setEditor] = useState<Editor | null>(null)
  const [quickJump, setQuickJump] = useState(false)
  const [changePassword, setChangePassword] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const menu = useContextMenu()

  const onEditorReady = useCallback((e: Editor | null) => setEditor(e), [])

  /* 启动同步；窗口重新获得焦点时补一次增量拉取，防止睡眠期间漏消息 */
  useEffect(() => {
    sync.start()
    const onFocus = () => void sync.pullDelta()
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

  /* 主题：跟随系统，并同步给主进程以刷新标题栏按钮配色 */
  useEffect(() => {
    let dispose: (() => void) | undefined
    void window.cloudnote?.info().then((info) => setTheme(info.theme))
    dispose = window.cloudnote?.onThemeChange((t) => setTheme(t))
    return () => dispose?.()
  }, [setTheme])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

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

  const accountActions: (MenuAction | 'separator')[] = [
    {
      label: '快速跳转…',
      icon: <IconJump size={15} />,
      shortcut: 'Ctrl+P',
      onSelect: () => setQuickJump(true),
    },
    {
      label: '导出全部笔记',
      icon: <IconExport size={15} />,
      onSelect: () => void exportAll(),
    },
    'separator',
    {
      label: '修改密码',
      icon: <IconKey size={15} />,
      onSelect: () => setChangePassword(true),
    },
    {
      label: theme === 'dark' ? '切换到浅色' : '切换到深色',
      icon: theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />,
      onSelect: () => {
        const next = theme === 'dark' ? 'light' : 'dark'
        setTheme(next)
        void window.cloudnote?.setTheme(next)
      },
    },
    'separator',
    {
      label: '退出登录',
      icon: <IconLogout size={15} />,
      danger: true,
      onSelect: () => {
        void sync.flushAll().finally(() => {
          sync.stop()
          session.clear()
          reset()
        })
      },
    },
  ]

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
        <button className="icon-btn" title="新建笔记 (Ctrl+N)" onClick={() => void sync.createNote(null)}>
          <IconPlus />
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

        <span className="titlebar-spacer" />

        <SyncChip />
        <button
          className="icon-btn"
          title={user?.display_name ?? '账号'}
          onClick={(e) => menu.openAt(e.currentTarget, accountActions)}
        >
          <IconMore />
        </button>
        {/* 给系统的窗口按钮留出位置 */}
        <span style={{ width: 138, flex: '0 0 auto' }} />
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
      {changePassword && <PasswordDialog onClose={() => setChangePassword(false)} />}
      {menu.node}
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
