import { contextBridge, ipcRenderer } from 'electron'

const api = {
  info: () => ipcRenderer.invoke('app:info') as Promise<{
    version: string
    platform: string
    /** 当下实际生效的配色 */
    theme: 'light' | 'dark'
    /** 主进程记住的外观选择，只用来对账；权威在渲染进程的 localStorage */
    themeMode: 'light' | 'dark' | 'system'
  }>,
  setTheme: (mode: 'light' | 'dark' | 'system') =>
    ipcRenderer.invoke('theme:set', mode) as Promise<'light' | 'dark'>,
  /** 开机自启：读写的都是系统登录项本身，没有另存的副本 */
  getAutoLaunch: () => ipcRenderer.invoke('autolaunch:get') as Promise<boolean>,
  setAutoLaunch: (on: boolean) => ipcRenderer.invoke('autolaunch:set', on) as Promise<boolean>,
  exportFile: (name: string, content: string) =>
    ipcRenderer.invoke('export:file', name, content) as Promise<{ ok: boolean; path?: string }>,
  exportFolder: (files: { path: string; content: string }[]) =>
    ipcRenderer.invoke('export:folder', files) as Promise<{ ok: boolean; path?: string; count?: number }>,
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path) as Promise<void>,

  /** 下载安装包到临时目录，边下边校验 sha256，返回本地路径 */
  downloadUpdate: (url: string, sha256: string) =>
    ipcRenderer.invoke('update:download', url, sha256) as Promise<string>,
  /** 拉起安装程序并退出应用 */
  installUpdate: (path: string) => ipcRenderer.invoke('update:install', path) as Promise<void>,
  onUpdateProgress: (cb: (p: { received: number; total: number }) => void) => {
    const handler = (_e: unknown, p: { received: number; total: number }) => cb(p)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.off('update:progress', handler)
  },
  onThemeChange: (cb: (theme: 'light' | 'dark') => void) => {
    const handler = (_e: unknown, theme: 'light' | 'dark') => cb(theme)
    ipcRenderer.on('theme:changed', handler)
    return () => ipcRenderer.off('theme:changed', handler)
  },
}

contextBridge.exposeInMainWorld('cloudnote', api)

export type CloudnoteApi = typeof api
