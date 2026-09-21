import { api, fileUrl } from './api'
import { desktop, isDesktop, isNative } from './platform'
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

/**
 * 客户端发布通道。服务端按这个字段存，各端检查更新只看自己那条：
 * 桌面端看 win32 + win32-asar，安卓看 android，网页版按设备给下载入口。
 * 后台上传按扩展名认类型，服务端那边也有同一份白名单（routes.js）。
 */
export const PLATFORMS = {
  win32: { label: 'Windows 安装包', ext: '.exe', hint: '整包，装了就能用' },
  'win32-asar': { label: 'Windows 热更新', ext: '.asar', hint: '只换代码，重启生效' },
  android: { label: '安卓 APK', ext: '.apk', hint: '手机直接安装' },
} as const
export type Platform = keyof typeof PLATFORMS

/** 服务端上热更新包走的「平台」通道，和整包的 win32 分开存 */
export const HOT_PLATFORM: Platform = 'win32-asar'

/** 按文件扩展名猜通道；认不出返回 null，让人自己选 */
export function platformFromFilename(name: string): Platform | null {
  const lower = name.toLowerCase()
  for (const [key, p] of Object.entries(PLATFORMS)) {
    if (lower.endsWith(p.ext)) return key as Platform
  }
  return null
}

export interface UpdateInfo extends Release {
  /** 拼好的绝对下载地址，主进程直接拿去 fetch */
  downloadUrl: string
  /** hot：2 MB 的热更新包，下完重启即可；exe：完整安装包，要跑安装程序；apk：安卓包，下完拉起系统安装页 */
  kind: 'hot' | 'exe' | 'apk'
}

const isRelease = (r: Release | Record<string, never>): r is Release => 'version' in r && !!r.version

const toInfo = (r: Release, kind: UpdateInfo['kind']): UpdateInfo => ({ ...r, downloadUrl: fileUrl(r.url), kind })

/**
 * 查有没有新版本。没有、查不到、或者是网页版，都返回 null——
 * 这个功能失败了不该打扰用户，静默略过就行。
 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  try {
    if (isDesktop) return await checkDesktopUpdate()
    if (isNative) return await checkAndroidUpdate()
    return null
  } catch {
    return null
  }
}

/**
 * 桌面端：热更新包和整包各取最新一条，都比当前新的话优先热更新
 * （版本不低于整包、且没有因为 Electron 不匹配被拒过）。整包只在热更新给不了时才提示。
 */
async function checkDesktopUpdate(): Promise<UpdateInfo | null> {
  if (!desktop) return null
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
  if (hotOk && hotRel) return toInfo(hotRel, 'hot')
  if (exeRel) return toInfo(exeRel, 'exe')
  return null
}

/** 安卓壳：只看 android 通道，当前版本是构建时写进去的 */
async function checkAndroidUpdate(): Promise<UpdateInfo | null> {
  const rel = await api.latestRelease('android')
  if (!isRelease(rel) || compareVersion(rel.version, __APP_VERSION__) <= 0) return null
  return toInfo(rel, 'apk')
}

/** 网页端「下载客户端」用：不比版本，有什么就给什么 */
export async function fetchLatestRelease(platform: Platform = 'win32'): Promise<UpdateInfo | null> {
  try {
    const latest = await api.latestRelease(platform)
    if (!isRelease(latest)) return null
    return toInfo(latest, platform === 'android' ? 'apk' : platform === HOT_PLATFORM ? 'hot' : 'exe')
  } catch {
    return null
  }
}

/** 网页版能给人下的两样东西；某个通道还没发过就没有那一项 */
export interface Downloads {
  android?: UpdateInfo
  windows?: UpdateInfo
}

/**
 * 网页版的下载入口都从这里取：手机上只关心安卓包，电脑上两样都要。
 * 并发取，一个失败不影响另一个。
 */
export async function fetchDownloads(which: 'android' | 'all'): Promise<Downloads> {
  const [android, windows] = await Promise.all([
    fetchLatestRelease('android'),
    which === 'all' ? fetchLatestRelease('win32') : Promise.resolve(null),
  ])
  const out: Downloads = {}
  if (android) out.android = android
  if (windows) out.windows = windows
  return out
}

/**
 * 网页版下载客户端：现拿一次最新版本，直接交给浏览器下。
 * 顶部按钮和设置里的「关于」都走这里，别各写一份。
 */
export async function downloadClient(platform: 'android' | 'win32'): Promise<void> {
  const info = await fetchLatestRelease(platform)
  if (!info) {
    useStore.getState().showToast({
      message: platform === 'android' ? '服务器上还没有发布安卓版' : '服务器上还没有发布 Windows 客户端',
    })
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
