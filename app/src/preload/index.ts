import { contextBridge, ipcRenderer } from 'electron'

const api = {
  info: () => ipcRenderer.invoke('app:info') as Promise<{
    version: string
    platform: string
    theme: 'light' | 'dark'
  }>,
  setTheme: (mode: 'light' | 'dark' | 'system') =>
    ipcRenderer.invoke('theme:set', mode) as Promise<'light' | 'dark'>,
  exportFile: (name: string, content: string) =>
    ipcRenderer.invoke('export:file', name, content) as Promise<{ ok: boolean; path?: string }>,
  exportFolder: (files: { path: string; content: string }[]) =>
    ipcRenderer.invoke('export:folder', files) as Promise<{ ok: boolean; path?: string; count?: number }>,
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path) as Promise<void>,
  onThemeChange: (cb: (theme: 'light' | 'dark') => void) => {
    const handler = (_e: unknown, theme: 'light' | 'dark') => cb(theme)
    ipcRenderer.on('theme:changed', handler)
    return () => ipcRenderer.off('theme:changed', handler)
  },
}

contextBridge.exposeInMainWorld('cloudnote', api)

export type CloudnoteApi = typeof api
