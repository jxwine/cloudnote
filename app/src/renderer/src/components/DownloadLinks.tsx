import { useEffect, useState } from 'react'
import { isDesktop, isIOS, isNative, isStandalone } from '@/lib/platform'
import { useStore } from '@/lib/store'
import { fetchDownloads, formatBytes, type Downloads } from '@/lib/update'
import { IconAndroid, IconApple, IconWindows } from './Icons'

/** iPhone 安装页的路由，App.tsx 按它切页面 */
export const IOS_ROUTE = '#/ios'

/**
 * 网页版的「下载客户端」入口，登录页 / 顶栏 / 设置关于页共用同一份：并排的平台图标。
 *
 * 按设备给：
 *   电脑（桌面 / 平板档）   安卓 · Windows · iPhone 三个并排
 *   安卓手机的浏览器        只给安卓
 *   iPhone / iPad          只给 iPhone；已经从主屏幕全屏打开的什么都不给
 * 安卓 / Windows 只在服务器上发过那个通道时才出现；iPhone 那项走描述文件，不依赖发布，
 * 点了进单独的安装页（#/ios）——那里有完整的图示步骤和下载按钮。
 *
 * tiles：带文字的方块（登录页、关于页）；icons：顶栏那种 28px 图标按钮。
 */
export function DownloadLinks({ variant }: { variant: 'tiles' | 'icons' }) {
  const viewport = useStore((s) => s.viewport)
  const [downloads, setDownloads] = useState<Downloads>({})

  const phone = viewport === 'phone'
  const isAndroidBrowser = /Android/i.test(navigator.userAgent)

  useEffect(() => {
    if (isDesktop || isNative) return
    let alive = true
    void fetchDownloads(phone ? 'android' : 'all').then((d) => alive && setDownloads(d))
    return () => {
      alive = false
    }
  }, [phone])

  if (isDesktop || isNative) return null

  const showAndroid = !!downloads.android && !isIOS
  const showWindows = !!downloads.windows && !phone
  const showIOS = !isStandalone && !isAndroidBrowser
  if (!showAndroid && !showWindows && !showIOS) return null

  interface Item {
    key: string
    label: string
    /** 一行式里放右边的小字：版本和大小，iPhone 那项是说明 */
    meta: string
    href: string
    download?: string
    title: string
  }
  const items: Item[] = []
  if (showAndroid && downloads.android) {
    const d = downloads.android
    items.push({
      key: 'android', label: '安卓', meta: `v${d.version} · ${formatBytes(d.size)}`,
      href: d.downloadUrl, download: d.filename, title: `安卓端 v${d.version} · ${formatBytes(d.size)}`
    })
  }
  if (showWindows && downloads.windows) {
    const d = downloads.windows
    items.push({
      key: 'windows', label: 'Windows', meta: `v${d.version} · ${formatBytes(d.size)}`,
      href: d.downloadUrl, download: d.filename, title: `Windows 客户端 v${d.version} · ${formatBytes(d.size)}`
    })
  }
  if (showIOS) {
    items.push({ key: 'ios', label: 'iPhone', meta: '安装到主屏幕', href: IOS_ROUTE, title: 'iPhone / iPad：安装到主屏幕' })
  }

  if (variant === 'icons') {
    return (
      <div className="dl-group" role="group" aria-label="下载客户端">
        {items.map((it) => (
          <a key={it.key} className="icon-btn dl-icon" href={it.href} download={it.download} title={it.title}>
            <Glyph k={it.key} size={16} />
          </a>
        ))}
      </div>
    )
  }

  // 三个并排才铺方块；只有一两个（手机上永远是一个）时铺成方块又大又空，改成一行式
  if (items.length >= 3) {
    return (
      <div className="dl-tiles" role="group" aria-label="下载客户端">
        {items.map((it) => (
          <a key={it.key} className="dl-tile" href={it.href} download={it.download} title={it.title}>
            <Glyph k={it.key} size={26} />
            <span className="dl-tile-label">{it.label}</span>
          </a>
        ))}
      </div>
    )
  }
  return (
    <div className="dl-rows" role="group" aria-label="下载客户端">
      {items.map((it) => (
        <a key={it.key} className="dl-row" href={it.href} download={it.download} title={it.title}>
          <Glyph k={it.key} size={18} />
          <span className="dl-row-label">{it.key === 'ios' ? '安装到 iPhone 主屏幕' : `下载${it.label}端`}</span>
          <span className="dl-row-meta">{it.meta}</span>
        </a>
      ))}
    </div>
  )
}

function Glyph({ k, size }: { k: string; size: number }) {
  if (k === 'android') return <IconAndroid size={size} />
  if (k === 'windows') return <IconWindows size={size} />
  return <IconApple size={size} />
}
