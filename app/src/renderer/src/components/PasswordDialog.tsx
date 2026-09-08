import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useStore } from '@/lib/store'

/** 修改密码。改完不踢下线——现有 token 仍然有效。 */
export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)
  const showToast = useStore((s) => s.showToast)

  useEffect(() => {
    firstRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (newPassword !== confirm) {
      setError('两次输入的新密码不一致')
      return
    }
    setError('')
    setBusy(true)
    try {
      await api.changePassword(oldPassword, newPassword)
      showToast({ message: '密码已修改，其他设备不受影响' })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改失败')
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <label className="dialog-title">修改密码</label>

        {error && <p className="auth-error">{error}</p>}

        <div className="field">
          <label htmlFor="pw-old">当前密码</label>
          <input
            id="pw-old"
            ref={firstRef}
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => setOld(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pw-new">新密码</label>
          <input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            placeholder="至少 6 位"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pw-confirm">再输一次</label>
          <input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        <div className="dialog-actions">
          <span className="dialog-spacer" />
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? '提交中…' : '修改'}
          </button>
        </div>
      </form>
    </div>
  )
}
