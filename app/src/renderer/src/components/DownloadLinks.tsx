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

  const cls = variant === 'tiles' ? 'dl-tile' : 'icon-btn dl-icon'
  const size = variant === 'tiles' ? 26 : 16
  const label = (text: string) => variant === 'tiles' && <span className="dl-tile-label">{text}</span>

  return (
    <div className={variant === 'tiles' ? 'dl-tiles' : 'dl-group'} role="group" aria-label="下载客户端">
      {showAndroid && downloads.android && (
        <a
          className={cls}
          href={downloads.android.downloadUrl}
          download={downloads.android.filename}
          title={`安卓端 v${downloads.android.version} · ${formatBytes(downloads.android.size)}`}
        >
          <IconAndroid size={size} />
          {label('安卓')}
        </a>
      )}
      {showWindows && downloads.windows && (
        <a
          className={cls}
          href={downloads.windows.downloadUrl}
          download={downloads.windows.filename}
          title={`Windows 客户端 v${downloads.windows.version} · ${formatBytes(downloads.windows.size)}`}
        >
          <IconWindows size={size} />
          {label('Windows')}
        </a>
      )}
      {showIOS && (
        <a className={cls} href={IOS_ROUTE} title="iPhone / iPad：安装到主屏幕">
          <IconApple size={size} />
          {label('iPhone')}
        </a>
      )}
    </div>
  )
}
