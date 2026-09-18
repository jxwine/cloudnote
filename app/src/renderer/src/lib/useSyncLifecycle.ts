import { useEffect } from 'react'
import * as sync from './sync'

/**
 * 同步引擎的生命周期：登录后启动；窗口重新获得焦点时补一次增量拉取，防止睡眠期间漏消息。
 * 桌面三栏和手机外壳都要，所以从 Workspace 里抽出来。
 */
export function useSyncLifecycle() {
  useEffect(() => {
    sync.start()
    // 用 syncNow 而不是裸的 pullDelta：必须先把本地攒着的改动送出去再拉远端，
    // 否则合盖再打开这一下就会把别的设备刚写的内容静默盖掉
    const onFocus = () => void sync.syncNow()
    const onOnline = () => {
      sync.stop()
      sync.start()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      sync.stop()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [])
}
