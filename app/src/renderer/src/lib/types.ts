export interface User {
  id: string
  email: string
  display_name: string
  seq: number
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  sortOrder: number
  version: number
  seq: number
  deleted: boolean
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: string
  folderId: string | null
  title: string
  content: string
  excerpt: string
  sortOrder: number
  version: number
  seq: number
  deleted: boolean
  conflictOf: string | null
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** 历史版本的元信息，列表接口不返回正文 */
export interface Revision {
  id: string
  title: string
  version: number
  size: number
  createdAt: number
}

export type SyncStatus = 'offline' | 'connecting' | 'synced' | 'syncing' | 'error'

export interface OutlineItem {
  id: string
  level: number
  text: string
  pos: number
}

/** 编辑器上方的横幅提示，例如「其他设备改动已存为冲突副本」 */
export interface ConflictNotice {
  noteId: string
  copyId: string
  copyTitle: string
  at: number
}

/** 底部一闪而过的提示，可带一个撤销动作 */
export interface Toast {
  id: number
  message: string
  actionLabel?: string
  onAction?: () => void
}

/**
 * 输入对话框。Electron 里 window.prompt 是被禁用的（直接返回 undefined），
 * 所以取链接、图片地址这类输入统一走自己的对话框。
 */
export interface PromptRequest {
  title: string
  initial: string
  placeholder?: string
  confirmLabel?: string
  /** 额外的第三个按钮，比如「移除链接」 */
  extraLabel?: string
  resolve: (value: string | null) => void
}

declare global {
  interface Window {
    cloudnote?: {
      info(): Promise<{ version: string; platform: string; theme: 'light' | 'dark' }>
      setTheme(mode: 'light' | 'dark' | 'system'): Promise<'light' | 'dark'>
      exportFile(name: string, content: string): Promise<{ ok: boolean; path?: string }>
      exportFolder(
        files: { path: string; content: string }[]
      ): Promise<{ ok: boolean; path?: string; count?: number }>
      reveal(path: string): Promise<void>
      onThemeChange(cb: (theme: 'light' | 'dark') => void): () => void
    }
  }
}
