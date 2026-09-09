import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useStore } from '@/lib/store'
import type { AdminUser } from '@/lib/types'
import { useContextMenu, type MenuAction } from '../ContextMenu'
import { IconMore, IconSearch } from '../Icons'

const PAGE = 30

const fmtDate = (t: number | null) => {
  if (!t) return '—'
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 「3 天前」这种相对说法，比绝对时间更容易一眼判断谁还在用 */
const fmtAgo = (t: number | null) => {
  if (!t) return '从未'
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 300) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return fmtDate(t)
}

export function AdminUsers() {
  const [rows, setRows] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null)
  const showToast = useStore((s) => s.showToast)
  const promptFor = useStore((s) => s.prompt)
  const me = useStore((s) => s.user)
  const menu = useContextMenu()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.adminUsers(q, PAGE, offset)
      setRows(res.users)
      setTotal(res.total)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [q, offset])

  // 搜索词变了要回到第一页，否则会停在一个不存在的偏移上
  useEffect(() => setOffset(0), [q])
  useEffect(() => {
    const t = setTimeout(() => void load(), 250)
    return () => clearTimeout(t)
  }, [load])

  const toggleDisabled = async (u: AdminUser) => {
    try {
      await api.adminSetUser(u.id, { disabled: !u.disabled })
      showToast({ message: u.disabled ? `已启用 ${u.email}` : `已停用 ${u.email}，该账号的设备已断开` })
      void load()
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : '操作失败' })
    }
  }

  const resetPassword = async (u: AdminUser) => {
    const pw = await promptFor({
      title: `给 ${u.email} 设一个新密码`,
      initial: '',
      placeholder: '至少 6 位',
      confirmLabel: '重置',
    })
    if (!pw) return
    try {
      await api.adminSetUser(u.id, { password: pw })
      showToast({ message: '密码已重置，请把新密码告诉本人' })
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : '重置失败' })
    }
  }

  const actionsFor = (u: AdminUser): MenuAction[] => {
    const self = u.id === me?.id
    return [
      {
        label: u.disabled ? '启用账号' : '停用账号',
        onSelect: () => void toggleDisabled(u),
        disabled: self,
      },
      { label: '重置密码', onSelect: () => void resetPassword(u) },
      {
        label: '删除账号及全部数据',
        danger: true,
        disabled: self,
        onSelect: () => setConfirmDelete(u),
      },
    ]
  }

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <div className="admin-search">
          <IconSearch size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索邮箱或昵称"
            spellCheck={false}
          />
        </div>
        <span className="admin-count">{loading ? '读取中…' : `共 ${total} 个账号`}</span>
      </div>

      {error && <p className="auth-error">{error}</p>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>账号</th>
              <th className="num">笔记</th>
              <th className="num">目录</th>
              <th>注册时间</th>
              <th>最后活跃</th>
              <th>状态</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className={u.disabled ? 'is-disabled' : ''}>
                <td>
                  <div className="admin-user">
                    <span className="admin-user-name">
                      {u.displayName}
                      {u.id === me?.id && <em className="admin-self">你</em>}
                    </span>
                    <span className="admin-user-mail">{u.email}</span>
                  </div>
                </td>
                <td className="num">{u.notes}</td>
                <td className="num">{u.folders}</td>
                <td className="dim">{fmtDate(u.createdAt)}</td>
                <td className="dim">{fmtAgo(u.lastActiveAt)}</td>
                <td>
                  {u.disabled ? (
                    <span className="admin-tag is-off">已停用</span>
                  ) : u.online > 0 ? (
                    <span className="admin-tag is-live">在线 {u.online}</span>
                  ) : (
                    <span className="admin-tag">正常</span>
                  )}
                </td>
                <td className="admin-row-actions">
                  <button
                    className="icon-btn"
                    title="操作"
                    onClick={(e) => menu.openAt(e.currentTarget, actionsFor(u))}
                  >
                    <IconMore size={16} />
                  </button>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="tree-empty">
                  {q ? '没有匹配的账号' : '还没有任何账号'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE && (
        <div className="admin-pager">
          <button
            className="btn-ghost"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            上一页
          </button>
          <span className="dim">
            {offset + 1}–{Math.min(offset + PAGE, total)} / {total}
          </span>
          <button
            className="btn-ghost"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            下一页
          </button>
        </div>
      )}

      {confirmDelete && (
        <DeleteUserDialog
          user={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onDone={() => {
            setConfirmDelete(null)
            void load()
          }}
        />
      )}
      {menu.node}
    </div>
  )
}

/**
 * 删除账号的确认框。
 *
 * 要求手输邮箱才放行——这一步不可撤销，笔记、目录、历史版本、图片全没了。
 * 服务端也会再校验一次这个邮箱，不是只靠前端拦。
 */
function DeleteUserDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser
  onClose: () => void
  onDone: () => void
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const showToast = useStore((s) => s.showToast)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await api.adminDeleteUser(user.id, typed.trim())
      showToast({ message: `已删除 ${user.email} 及其全部数据` })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={() => !busy && onClose()}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <label className="dialog-title">删除账号</label>
        {error && <p className="auth-error">{error}</p>}
        <p className="admin-warn">
          将永久删除 <b>{user.email}</b> 的 {user.notes} 篇笔记、{user.folders} 个目录、
          全部历史版本和上传的图片。<b>此操作不可恢复。</b>
        </p>
        <div className="field">
          <label htmlFor="del-confirm">输入该账号的邮箱以确认</label>
          <input
            id="del-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={user.email}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="dialog-actions">
          <span className="dialog-spacer" />
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="submit"
            className="btn-ghost is-danger"
            disabled={busy || typed.trim().toLowerCase() !== user.email}
          >
            {busy ? '删除中…' : '确认删除'}
          </button>
        </div>
      </form>
    </div>
  )
}
