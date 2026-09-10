import { create } from 'zustand'
import type { ConflictNotice, Folder, Note, PromptRequest, SyncStatus, Toast, User } from './types'
import { session } from './api'

const CACHE_KEY = 'cloudnote.cache'
const UI_KEY = 'cloudnote.ui'

interface CacheShape {
  lastSeq: number
  folders: Record<string, Folder>
  notes: Record<string, Note>
}

/**
 * 用户在设置里选的外观，要记住。
 * 和下面那个 theme 不是一回事：这是「选择」，theme 是「当下实际生效的配色」——
 * 选了 system 时 theme 会跟着系统在 light/dark 之间来回变，themeMode 始终是 system。
 */
export type ThemeMode = 'system' | 'light' | 'dark'

interface UiShape {
  leftOpen: boolean
  rightOpen: boolean
  expanded: Record<string, boolean>
  activeNoteId: string | null
  leftWidth: number
  rightWidth: number
  themeMode: ThemeMode
}

/** 系统当前是不是深色。网页端和桌面端都能用，桌面端启动后会被主进程的结果覆盖 */
const systemPrefersDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches

export const resolveTheme = (mode: ThemeMode): 'light' | 'dark' =>
  mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode

const readCache = (): CacheShape => {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) return JSON.parse(raw) as CacheShape
  } catch {
    /* 缓存损坏就当没有，下次全量拉取即可 */
  }
  return { lastSeq: 0, folders: {}, notes: {} }
}

const readUi = (): UiShape => {
  const fallback: UiShape = {
    leftOpen: true,
    rightOpen: true,
    expanded: {},
    activeNoteId: null,
    leftWidth: 248,
    rightWidth: 232,
    themeMode: 'system',
  }
  try {
    const raw = localStorage.getItem(UI_KEY)
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<UiShape>) } : fallback
  } catch {
    return fallback
  }
}

interface State extends CacheShape, UiShape {
  user: User | null
  status: SyncStatus
  peers: number
  /** 当前笔记是否有尚未落库的改动——决定收到远端更新时是热更新还是生成冲突副本 */
  dirtyNoteId: string | null
  notices: ConflictNotice[]
  search: string
  /**
   * 登录凭证失效了（token 过期 / 账号被停用）。
   *
   * 单独一个状态而不是直接踢回登录页：用户手里可能还有没同步上去的内容，
   * 一脚踢走顺手 reset() 就把本地缓存清了。先停下来告诉他，
   * 让他自己点「重新登录」，缓存和待发队列原样留着。
   */
  authExpired: string | null

  /** 侧栏当前视图：目录树 / 标签 / 回收站 */
  sidebarView: 'tree' | 'tags' | 'trash'
  tagFilter: string | null
  theme: 'light' | 'dark'
  savingAt: number | null
  toast: Toast | null
  dialog: PromptRequest | null
  /** 每点一次搜索结果就加新，用来触发正文跳到命中处——点的可能正是已打开的那篇 */
  searchJump: number

  setUser(user: User | null): void
  setStatus(status: SyncStatus, peers?: number): void
  setDirty(noteId: string | null): void
  applyFolder(folder: Folder): void
  applyNote(note: Note): void
  applyBatch(folders: Folder[], notes: Note[], seq?: number): void
  dropLocal(kind: 'note' | 'folder', id: string): void
  setActive(id: string | null): void
  toggleExpand(id: string, value?: boolean): void
  setPanel(side: 'left' | 'right', open: boolean): void
  setPanelWidth(side: 'left' | 'right', px: number): void
  setSearch(q: string): void
  setSidebarView(view: 'tree' | 'tags' | 'trash'): void
  setAuthExpired(reason: string | null): void
  setTagFilter(tag: string | null): void
  jumpToSearchHit(noteId: string): void
  /** 只改「当下生效的配色」，不动用户的选择。系统主题变化走这条 */
  setTheme(theme: 'light' | 'dark'): void
  /** 用户在设置里改外观：记住选择，并立刻按新选择推一个生效值出去 */
  setThemeMode(mode: ThemeMode): void
  /** 弹出输入框，返回用户输入；取消返回 null，点额外按钮返回空串 */
  prompt(opts: Omit<PromptRequest, 'resolve'>): Promise<string | null>
  closeDialog(value: string | null): void
  showToast(t: Omit<Toast, 'id'>): void
  hideToast(): void
  pushNotice(n: ConflictNotice): void
  dismissNotice(copyId: string): void
  markSaved(): void
  reset(): void
}

let cacheTimer: ReturnType<typeof setTimeout> | null = null
let uiTimer: ReturnType<typeof setTimeout> | null = null

export const useStore = create<State>((set, get) => {
  const ui = readUi()

  const persistCache = () => {
    if (cacheTimer) clearTimeout(cacheTimer)
    cacheTimer = setTimeout(() => {
      const { lastSeq, folders, notes } = get()
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ lastSeq, folders, notes }))
      } catch {
        /* 超出配额时放弃缓存，不影响在线使用 */
      }
    }, 400)
  }

  const writeUi = () => {
    const { leftOpen, rightOpen, expanded, activeNoteId, leftWidth, rightWidth, themeMode } = get()
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({ leftOpen, rightOpen, expanded, activeNoteId, leftWidth, rightWidth, themeMode })
    )
  }

  /** 拖宽度、开合侧栏这类会连着来的，攒一下再写 */
  const persistUi = () => {
    if (uiTimer) clearTimeout(uiTimer)
    uiTimer = setTimeout(writeUi, 300)
  }

  return {
    ...readCache(),
    ...ui,
    user: session.user,
    status: 'offline',
    peers: 0,
    dirtyNoteId: null,
    notices: [],
    search: '',
    sidebarView: 'tree',
    tagFilter: null,
    authExpired: null,
    // 先按记住的选择推一个出来，别等主进程回话——否则深色用户每次启动都要闪一下白
    theme: resolveTheme(ui.themeMode),
    savingAt: null,
    toast: null,
    dialog: null,
    searchJump: 0,

    prompt: (opts) =>
      new Promise<string | null>((resolve) => set({ dialog: { ...opts, resolve } })),

    closeDialog: (value) => {
      const dialog = get().dialog
      set({ dialog: null })
      dialog?.resolve(value)
    },

    setUser: (user) => set({ user }),
    setStatus: (status, peers) =>
      set((s) => ({ status, peers: peers === undefined ? s.peers : peers })),
    setDirty: (dirtyNoteId) => set({ dirtyNoteId }),

    applyFolder: (folder) => {
      set((s) => ({
        folders: { ...s.folders, [folder.id]: folder },
        lastSeq: Math.max(s.lastSeq, folder.seq),
      }))
      persistCache()
    },

    applyNote: (note) => {
      set((s) => ({
        notes: { ...s.notes, [note.id]: note },
        lastSeq: Math.max(s.lastSeq, note.seq),
      }))
      persistCache()
    },

    applyBatch: (folders, notes, seq) => {
      set((s) => {
        const nextFolders = { ...s.folders }
        const nextNotes = { ...s.notes }
        let maxSeq = s.lastSeq
        for (const f of folders) {
          nextFolders[f.id] = f
          maxSeq = Math.max(maxSeq, f.seq)
        }
        for (const n of notes) {
          // 正在编辑的笔记不被后台批量拉取覆盖，避免吞掉用户正在敲的字
          if (n.id === s.dirtyNoteId && !n.deleted) {
            nextNotes[n.id] = { ...s.notes[n.id], version: n.version, seq: n.seq }
          } else {
            nextNotes[n.id] = n
          }
          maxSeq = Math.max(maxSeq, n.seq)
        }
        return { folders: nextFolders, notes: nextNotes, lastSeq: seq ?? maxSeq }
      })
      persistCache()
    },

    dropLocal: (kind, id) => {
      set((s) => {
        if (kind === 'note') {
          const notes = { ...s.notes }
          delete notes[id]
          return { notes, activeNoteId: s.activeNoteId === id ? null : s.activeNoteId }
        }
        const folders = { ...s.folders }
        delete folders[id]
        return { folders }
      })
      persistCache()
    },

    setActive: (activeNoteId) => {
      set({ activeNoteId })
      persistUi()
    },

    toggleExpand: (id, value) => {
      set((s) => ({ expanded: { ...s.expanded, [id]: value ?? !s.expanded[id] } }))
      persistUi()
    },

    setPanel: (side, open) => {
      set(side === 'left' ? { leftOpen: open } : { rightOpen: open })
      persistUi()
    },

    setPanelWidth: (side, px) => {
      const clamped = Math.min(420, Math.max(180, Math.round(px)))
      set(side === 'left' ? { leftWidth: clamped } : { rightWidth: clamped })
      persistUi()
    },

    setSearch: (search) => set({ search }),
    setSidebarView: (sidebarView) => set({ sidebarView, tagFilter: null }),
    setAuthExpired: (authExpired) => set({ authExpired }),
    // 筛选结果显示在标签视图里，返回时能退回标签总览；
    // 同时清掉搜索词，免得两种过滤叠在一起看不出当前在看什么
    setTagFilter: (tagFilter) => set({ tagFilter, sidebarView: 'tags', search: '' }),

    jumpToSearchHit: (noteId) => {
      set({ activeNoteId: noteId, searchJump: Date.now() })
      persistUi()
    },
    setTheme: (theme) => set({ theme }),

    setThemeMode: (themeMode) => {
      set({ themeMode, theme: resolveTheme(themeMode) })
      // 立刻写，不走防抖：改完主题随手关掉标签页的话，攒着的那次写就没了。
      // 这个动作一次只来一下，不像拖宽度那样连着触发，没有攒的必要
      writeUi()
    },

    showToast: (t) => set({ toast: { ...t, id: Date.now() } }),
    hideToast: () => set({ toast: null }),

    pushNotice: (n) => set((s) => ({ notices: [...s.notices.filter((x) => x.copyId !== n.copyId), n] })),
    dismissNotice: (copyId) => set((s) => ({ notices: s.notices.filter((n) => n.copyId !== copyId) })),

    markSaved: () => set({ savingAt: Date.now(), dirtyNoteId: null }),

    reset: () => {
      localStorage.removeItem(CACHE_KEY)
      set({
        lastSeq: 0,
        folders: {},
        notes: {},
        activeNoteId: null,
        user: null,
        status: 'offline',
        notices: [],
        dirtyNoteId: null,
        toast: null,
        dialog: null,
        sidebarView: 'tree',
        tagFilter: null,
        authExpired: null,
      })
    },
  }
})

/* ---------------- 选择器 ---------------- */

export interface TreeNode {
  folder: Folder
  children: TreeNode[]
  notes: Note[]
}

const byOrder = <T extends { sortOrder: number; updatedAt: number }>(a: T, b: T) =>
  a.sortOrder === b.sortOrder ? b.updatedAt - a.updatedAt : a.sortOrder - b.sortOrder

/** 把扁平的目录/笔记组装成侧栏需要的树；已软删的条目在这里被过滤掉 */
export function buildTree(
  folders: Record<string, Folder>,
  notes: Record<string, Note>
): { tree: TreeNode[]; rootNotes: Note[] } {
  const live = Object.values(folders).filter((f) => !f.deleted)
  const liveNotes = Object.values(notes).filter((n) => !n.deleted)
  const nodes = new Map<string, TreeNode>()
  for (const f of live) nodes.set(f.id, { folder: f, children: [], notes: [] })

  for (const n of liveNotes) {
    if (n.folderId && nodes.has(n.folderId)) nodes.get(n.folderId)!.notes.push(n)
  }

  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.folder.parentId ? nodes.get(node.folder.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sortNode = (n: TreeNode) => {
    n.children.sort((a, b) => byOrder(a.folder, b.folder))
    n.notes.sort(byOrder)
    n.children.forEach(sortNode)
  }
  roots.sort((a, b) => byOrder(a.folder, b.folder))
  roots.forEach(sortNode)

  const rootNotes = liveNotes
    .filter((n) => !n.folderId || !nodes.has(n.folderId))
    .sort(byOrder)

  return { tree: roots, rootNotes }
}
