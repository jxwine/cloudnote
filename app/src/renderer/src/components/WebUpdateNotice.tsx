import { useEffect, useState } from 'react'
import { isDesktop, isNative } from '@/lib/platform'
import { prepareForReload } from '@/lib/sync'
import { watchWebUpdate, webReloadUrl } from '@/lib/webUpdate'

/** 全局非阻塞提示：登录页、后台、手机与 PWA 都共享同一个检测器。 */
export function WebUpdateNotice() {
  const [available, setAvailable] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    if (isDesktop || isNative || !import.meta.env.PROD) return
    return watchWebUpdate(setAvailable)
  }, [])

  useEffect(() => { setError('') }, [available])

  if (!available || available === dismissed) return null

  const reload = () => {
    if (reloading) return
    if (!navigator.onLine) {
      setError('当前离线，请联网后再更新。')
      return
    }
    // 不等待网络：先结算编辑器与输入法，再同步保存本地草稿，刷新后继续补发。
    if (!prepareForReload()) {
      setError('草稿暂时无法安全保存，请保持页面打开，备份笔记后再试。')
      return
    }
    setReloading(true)
    location.replace(webReloadUrl(location.href))
  }

  return (
    <aside className="web-update-notice" aria-label="网页更新提示">
      <div role="status" aria-live="polite">
        <strong>网页已更新</strong>
        <p>刷新即可使用最新版本，更新前会保存本地草稿。</p>
      </div>
      {error && <p className="web-update-error" role="alert">{error}</p>}
      <div className="web-update-actions">
        <button type="button" className="btn-ghost" disabled={reloading} onClick={() => setDismissed(available)}>稍后</button>
        <button type="button" className="btn-primary" disabled={reloading} onClick={reload}>{reloading ? '正在更新…' : '立即更新'}</button>
      </div>
    </aside>
  )
}
