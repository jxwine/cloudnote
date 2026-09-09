import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useStore } from '@/lib/store'
import type { AdminStats } from '@/lib/types'
import { AdminUsers } from './AdminUsers'
import { AdminReleases } from './AdminReleases'
import { IconCloud, IconClose } from '../Icons'

type Tab = 'users' | 'releases'

/**
 * 后台管理外壳。
 *
 * 走 hash 路由（#/admin）而不是多页面构建：多出来的 html 会被打进 asar 白占体积，
 * 而 hash 在 dev、网页、桌面三处都能用，也不依赖 Nginx 的 SPA fallback。
 */
export function AdminApp({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('users')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const user = useStore((s) => s.user)

  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .adminStats()
        .then((s) => alive && setStats(s))
        .catch(() => {
          /* 统计条失败不影响下面的表格，静默略过 */
        })
    void load()
    const timer = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [tab])

  return (
    <div className="admin">
      <header className="admin-head">
        <span className="brand">
          <IconCloud size={15} className="brand-mark" />
          云笔记 · 后台
        </span>
        <span className="titlebar-spacer" />
        <span className="admin-who">{user?.email}</span>
        <button className="icon-btn" title="返回笔记" onClick={onExit}>
          <IconClose />
        </button>
      </header>

      <div className="admin-stats">
        <Stat label="账号" value={stats?.users} />
        <Stat label="笔记" value={stats?.notes} />
        <Stat label="目录" value={stats?.folders} />
        <Stat label="在线设备" value={stats?.onlineSockets} hint={`${stats?.onlineAccounts ?? 0} 个账号`} />
        <Stat label="客户端版本" value={stats?.releases} />
      </div>

      <nav className="admin-tabs">
        <button
          className={'admin-tab' + (tab === 'users' ? ' is-active' : '')}
          onClick={() => setTab('users')}
        >
          用户
        </button>
        <button
          className={'admin-tab' + (tab === 'releases' ? ' is-active' : '')}
          onClick={() => setTab('releases')}
        >
          客户端版本
        </button>
      </nav>

      <main className="admin-body">{tab === 'users' ? <AdminUsers /> : <AdminReleases />}</main>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value?: number; hint?: string }) {
  return (
    <div className="admin-stat">
      <span className="admin-stat-value">{value === undefined ? '—' : value}</span>
      <span className="admin-stat-label">{label}</span>
      {hint && <span className="admin-stat-hint">{hint}</span>}
    </div>
  )
}
