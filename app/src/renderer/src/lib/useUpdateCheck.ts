import { useEffect, useState } from 'react'
import { useStore } from './store'
import { isDesktop, isNative } from './platform'
import { checkUpdate, type UpdateInfo } from './update'

/**
 * 更新检查：登录后过 8 秒静默查一次，之后每 6 小时一次；设置里还能手动点。
 * 桌面端和安卓壳都用（各自只看自己的通道，见 update.ts），网页版什么都不做。
 * 查不到或者出错都不打扰用户——这个功能失败了不该弹窗。
 */
export function useUpdateCheck() {
  const showToast = useStore((s) => s.showToast)
  /** 正在弹的更新框；关掉就没了 */
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  /** 查到过的新版本，关掉弹窗也记着——设置里的版本号旁边靠它显示红点 */
  const [available, setAvailable] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    if (!isDesktop && !isNative) return
    let alive = true
    const run = () =>
      void checkUpdate().then((info) => {
        if (!alive) return
        setAvailable(info)
        if (info) setUpdate(info)
      })
    const first = setTimeout(run, 8_000)
    const timer = setInterval(run, 6 * 60 * 60 * 1000)
    return () => {
      alive = false
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [])

  /** 设置里手动点的那次：查不到也要给个回应，不然像是没反应 */
  const manualCheck = async () => {
    const info = await checkUpdate()
    setAvailable(info)
    if (info) setUpdate(info)
    else showToast({ message: '已经是最新版本' })
  }

  return { update, setUpdate, available, manualCheck }
}
