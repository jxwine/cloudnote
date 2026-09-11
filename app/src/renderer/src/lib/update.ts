import { api, fileUrl } from './api'
import { desktop, isDesktop } from './platform'
import { useStore } from './store'
import type { Release } from './types'

/**
 * 比大小的语义版本比较，够用就好。
 *
 * 只看前三段数字，后面的预发布标记（1.2.0-beta.1）一律当成「和 1.2.0 一样」。
 * 我们自己发版不会用预发布号，为这个引一个 semver 依赖不划算。
 * 返回 >0 表示 a 更新，<0 表示 b 更新，0 表示一样。
 */
export function compareVersion(a: string, b: string): number {
  const parse = (v: string) =>
    String(v || '')
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0)
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export interface UpdateInfo extends Release {
  /** 拼好的绝对下载地址，主进程直接拿去 fetch */
  downloadUrl: string
  /** hot：2 MB 的热更新包，下完重启即可；exe：完整安装包，要跑安装程序 */
  kind: 'hot' | 'exe'
}

/** 服务端上热更新包走的「平台」通道，和整包的 win32 分开存 */
export const HOT_PLATFORM = 'win32-asar'

const isRelease = (r: Release | Record<string, never>): r is Release => 'version' in r && !!r.version

/**
 * 查有没有新版本。没有、查不到、或者根本不在桌面端，都返回 null——
 * 这个功能失败了不该打扰用户，静默略过就行。
 *
 * 两条通道都看：热更新包和整包各取最新一条，都比当前新的话优先热更新
 * （版本不低于整包、且没有因为 Electron 不匹配被拒过）。整包只在热更新给不了时才提示。
 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isDesktop || !desktop) return null
  try {
    const [info, hot, exe] = await Promise.all([
      desktop.info(),
      api.latestRelease(HOT_PLATFORM).catch(() => ({}) as Record<string, never>),
      api.latestRelease(),
    ])
    const current = info.version
    const newer = (r: Release | Record<string, never>): Release | null =>
      isRelease(r) && compareVersion(r.version, current) > 0 ? r : null

    const hotRel = newer(hot)
    const exeRel = newer(exe)
    const hotOk =
      hotRel && !info.rejectedHot.includes(hotRel.version) && (!exeRel || compareVersion(hotRel.version, exeRel.version) >= 0)
    if (hotOk && hotRel) return { ...hotRel, downloadUrl: fileUrl(hotRel.url), kind: 'hot' }
    if (exeRel) return { ...exeRel, downloadUrl: fileUrl(exeRel.url), kind: 'exe' }
    return null
  } catch {
    return null
  }
}

/** 网页端「下载客户端」用：不比版本，有什么就给什么 */
export async function fetchLatestRelease(): Promise<UpdateInfo | null> {
  try {
    const latest = await api.latestRelease()
    if (!isRelease(latest)) return null
    return { ...latest, downloadUrl: fileUrl(latest.url), kind: 'exe' }
  } catch {
    return null
  }
}

/**
 * 网页版下载客户端：现拿一次最新版本，直接交给浏览器下。
 * 顶部按钮和设置里的「关于」都走这里，别各写一份。
 */
export async function downloadClient(): Promise<void> {
  const info = await fetchLatestRelease()
  if (!info) {
    useStore.getState().showToast({ message: '服务器上还没有发布任何客户端版本' })
    return
  }
  const a = document.createElement('a')
  a.href = info.downloadUrl
  a.download = info.filename
  a.click()
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
