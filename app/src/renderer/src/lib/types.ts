export interface User {
  id: string
  email: string
  displayName: string
  seq: number
  /** 由服务端按 .env 里的管理员名单判定，客户端只读 */
  isAdmin: boolean
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

/** 客户端发布包。服务端 toRelease() 的返回结构 */
export interface Release {
  id: string
  version: string
  platform: string
  filename: string
  size: number
  sha256: string
  notes: string
  published: boolean
  createdAt: number
  /** 相对路径，用 fileUrl() 拼成绝对地址 */
  url: string
}

export interface AdminUser {
  id: string
  email: string
  displayName: string
  createdAt: number
  lastActiveAt: number | null
  disabled: boolean
  notes: number
  folders: number
  online: number
}

export interface AdminStats {
  users: number
  notes: number
  folders: number
  onlineAccounts: number
  onlineSockets: number
  releases: number
}

declare global {
  /** 构建时注入的 app/package.json 版本号（electron.vite.config.ts 的 define） */
  const __APP_VERSION__: string

  interface Window {
    /** Capacitor 安卓壳注入的全局；网页版和桌面端没有 */
    Capacitor?: {
      isNativePlatform?: () => boolean
      getPlatform?: () => string
      /** 安卓壳里装了的插件；只用到这两个，按需声明 */
      Plugins?: {
        Filesystem?: {
          /** encoding 留空表示 data 是 base64 的二进制 */
          writeFile(o: {
            path: string
            data: string
            directory: string
            encoding?: string
            recursive?: boolean
          }): Promise<{ uri: string }>
          downloadFile(o: {
            url: string
            path: string
            directory: string
            progress?: boolean
          }): Promise<{ path?: string; blob?: unknown }>
          addListener(
            event: 'progress',
            fn: (p: { url: string; bytes: number; contentLength: number }) => void
          ): Promise<{ remove(): Promise<void> }>
        }
        /** 我们自己写的原生插件（android/…/InstallerPlugin.java）：拉起系统安装页 */
        Installer?: { install(o: { path: string }): Promise<void> }
        Share?: { share(o: { title?: string; text?: string; files?: string[] }): Promise<unknown> }
        StatusBar?: {
          /** LIGHT = 浅色底配深色图标，DARK 反之 */
          setStyle(o: { style: 'LIGHT' | 'DARK' }): Promise<void>
          setBackgroundColor(o: { color: string }): Promise<void>
          /** height 是 CSS 像素 */
          getInfo(): Promise<{ visible: boolean; height: number }>
        }
      }
    }
    cloudnote?: {
      info(): Promise<{
        version: string
        platform: string
        /** 当下实际生效的配色 */
        theme: 'light' | 'dark'
        /** 主进程记住的外观选择，桌面端以它为准 */
        themeMode: 'light' | 'dark' | 'system'
        /** 是不是从热更新包启动的 */
        hot: boolean
        /** 下载后发现 Electron 版本对不上的热更新版本，检查更新时跳过 */
        rejectedHot: string[]
      }>
      setTheme(mode: 'light' | 'dark' | 'system'): Promise<'light' | 'dark'>
      /** 开机自启，以系统登录项为准；set 返回写完后的真实状态 */
      getAutoLaunch(): Promise<boolean>
      setAutoLaunch(on: boolean): Promise<boolean>
      exportFile(name: string, content: string): Promise<{ ok: boolean; path?: string }>
      exportFolder(
        files: { path: string; content: string }[]
      ): Promise<{ ok: boolean; path?: string; count?: number }>
      reveal(path: string): Promise<void>
      onThemeChange(cb: (theme: 'light' | 'dark') => void): () => void
      downloadUpdate(url: string, sha256: string): Promise<string>
      installUpdate(path: string): Promise<void>
      downloadHotUpdate(url: string, sha256: string, version: string): Promise<string>
      applyHotUpdate(): Promise<void>
      onUpdateProgress(cb: (p: { received: number; total: number }) => void): () => void
    }
  }
}
