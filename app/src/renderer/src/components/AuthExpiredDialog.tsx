import { useStore } from '@/lib/store'
import { session } from '@/lib/api'
import * as sync from '@/lib/sync'
import { hasPending } from '@/lib/sync'
import { IconKey } from './Icons'

/**
 * 登录失效了。
 *
 * 这个框最要紧的事不是「让他去登录」，而是**先把「你的东西没丢」说清楚**。
 * 用户看到「登录已失效」第一反应就是刚写的东西是不是没了——尤其这时候
 * 状态栏还挂着红点。所以未同步的改动有没有、有多少，都直说。
 *
 * 「重新登录」只清 token，**不动本地缓存和待发队列**：同一个账号登回来，
 * restorePending 会把攒下的改动补发上去。
 */
export function AuthExpiredDialog() {
  const reason = useStore((s) => s.authExpired)
  const setUser = useStore((s) => s.setUser)
  const setAuthExpired = useStore((s) => s.setAuthExpired)
  if (!reason) return null

  const pending = hasPending()

  const relogin = () => {
    sync.stop()
    // 只清凭证。缓存和待发的改动留着，等他登回来自己补上去
    session.clear()
    setAuthExpired(null)
    setUser(null)
  }

  return (
    <div className="overlay">
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <label className="dialog-title">需要重新登录</label>
        <p className="auth-expired-reason">{reason}</p>
        <p className="auth-expired-hint">
          {pending ? (
            <>
              你还有<b>没同步上去的改动</b>，已经存在这台设备上了，没有丢。
              用<b>同一个账号</b>登回来就会自动补传。
            </>
          ) : (
            <>本机的笔记都还在，重新登录后继续用就行。</>
          )}
        </p>
        <div className="dialog-actions">
          <span className="dialog-spacer" />
          <button type="button" className="btn-primary" onClick={relogin}>
            <IconKey size={15} />
            重新登录
          </button>
        </div>
      </div>
    </div>
  )
}
