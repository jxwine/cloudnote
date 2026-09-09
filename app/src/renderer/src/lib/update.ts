import { api, fileUrl } from './api'
import { desktop, isDesktop } from './platform'
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
}

/**
 * 查有没有新版本。没有、查不到、或者根本不在桌面端，都返回 null——
 * 这个功能失败了不该打扰用户，静默略过就行。
 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isDesktop || !desktop) return null
  try {
    const [{ version: current }, latest] = await Promise.all([desktop.info(), api.latestRelease()])
    if (!('version' in latest) || !latest.version) return null
    if (compareVersion(latest.version, current) <= 0) return null
    return { ...(latest as Release), downloadUrl: fileUrl(latest.url) }
  } catch {
    return null
  }
}

/** 网页端「下载客户端」用：不比版本，有什么就给什么 */
export async function fetchLatestRelease(): Promise<UpdateInfo | null> {
  try {
    const latest = await api.latestRelease()
    if (!('version' in latest) || !latest.version) return null
    return { ...(latest as Release), downloadUrl: fileUrl(latest.url) }
  } catch {
    return null
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
