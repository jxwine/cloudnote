import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/lib/store'
import type { LockTarget } from '@/lib/types'
import { blockedLock, lockKey, readingTitle } from '@/lib/readingLock'
import { changeReadingLock, unlockReadingLock } from '@/lib/readingLockActions'
import type { MenuAction } from './ContextMenu'
import { IconLock } from './Icons'

/** 菜单点击时重新读取状态，避免弹出菜单后同步改变权限。 */
export function readingLockMenuActions(target: LockTarget): MenuAction[] {
  const state = useStore.getState()
  const ownLock = target.kind === 'note' ? state.notes[target.id]?.readingLock : state.folders[target.id]?.readingLock
  const request = (mode: 'set' | 'remove' | 'reset') => useStore.getState().requestReadingLock(target, mode)
  if (!ownLock) return [{ label: '设置阅读密码', icon: <IconLock size={16} />, disabled: !!blockedLock(state, target), onSelect: () => request('set') }]
  return [
    { label: '立即上锁', icon: <IconLock size={16} />, disabled: !!blockedLock(state, target), onSelect: () => useStore.getState().relock(target) },
    { label: '取消阅读密码', onSelect: () => request('remove') },
    { label: '重设阅读密码', onSelect: () => request('reset') },
  ]
}

export function ReadingLockPane({ target }: { target: LockTarget }) {
  const state = useStore()
  const blocking = blockedLock(state, target)
  const item = blocking && (blocking.kind === 'note' ? state.notes[blocking.id] : state.folders[blocking.id])
  const name = blocking ? readingTitle(state, blocking) : ''
  const identity = blocking ? `${lockKey(blocking)}:${item?.readingLock?.revision}:${state.lockEpoch}` : ''
  return <ReadingLockForm key={`${lockKey(target)}:${identity}`} target={blocking} unlockTarget={target} name={name} inherited={!!blocking && lockKey(blocking) !== lockKey(target)} />
}

function ReadingLockForm({ target, unlockTarget, name, inherited }: { target: LockTarget | null; unlockTarget: LockTarget; name: string; inherited: boolean }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!target || busy || !password) return
    setBusy(true)
    setError('')
    try {
      await unlockReadingLock(unlockTarget, password)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '解锁失败，请重试')
    } finally {
      if (mounted.current) { setBusy(false); setPassword('') }
    }
  }
  return (
    <main className="reading-lock-pane" aria-label="阅读密码保护">
      {target ? <form className="reading-lock-form" onSubmit={(e) => void submit(e)}>
        <IconLock size={34} className="reading-lock-mark" />
        <h1>{name}</h1>
        <p className="reading-lock-hint">{inherited ? '请先解锁所在目录' : '输入阅读密码后查看内容'}</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="off" placeholder="请输入阅读密码" aria-label="阅读密码" disabled={busy} />
        <button className="btn-primary" type="submit" disabled={busy || !password}>{busy ? '正在解锁…' : '解锁'}</button>
        {error && <p className="reading-lock-error" role="alert">{error}</p>}
        <div className="reading-lock-links">
          <button type="button" disabled={busy} onClick={() => useStore.getState().requestReadingLock(target, 'remove')}>取消密码</button>
          <span />
          <button type="button" disabled={busy} onClick={() => useStore.getState().requestReadingLock(target, 'reset')}>忘记密码</button>
        </div>
      </form> : <p className="reading-lock-hint">目录已解锁，请选择笔记</p>}
    </main>
  )
}

export function ReadingLockDialog() {
  const dialog = useStore((s) => s.readingLockDialog)
  return dialog ? <LockDialogForm key={`${lockKey(dialog.target)}:${dialog.mode}`} dialog={dialog} /> : null
}

function LockDialogForm({ dialog }: { dialog: { target: LockTarget; mode: 'set' | 'remove' | 'reset' } }) {
  const [accountPassword, setAccountPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const formRef = useRef<HTMLFormElement>(null)
  const close = () => { if (!busy) useStore.getState().closeReadingLockDialog() }
  useEffect(() => {
    mounted.current = true
    formRef.current?.querySelector('input')?.focus()
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
      if (e.key === 'Tab') {
        const fields = formRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')
        if (!fields?.length) return
        const first = fields[0], last = fields[fields.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy])
  const needsAccount = dialog.mode !== 'set'
  const needsNew = dialog.mode !== 'remove'
  const title = dialog.mode === 'set' ? '设置阅读密码' : dialog.mode === 'remove' ? '取消阅读密码' : '重设阅读密码'
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (needsNew && password !== confirm) { setError('两次输入的阅读密码不一致'); return }
    setBusy(true)
    setError('')
    try {
      await changeReadingLock(dialog.target, needsNew ? password : null, needsAccount ? accountPassword : undefined)
      if (mounted.current && useStore.getState().readingLockDialog === dialog) useStore.getState().closeReadingLockDialog()
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally { if (mounted.current) setBusy(false) }
  }
  return <div className="overlay reading-lock-overlay" onMouseDown={close}>
    <form ref={formRef} className="dialog reading-lock-dialog" role="dialog" aria-modal="true" aria-labelledby="reading-lock-dialog-title" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
      <h2 className="dialog-title" id="reading-lock-dialog-title">{title}</h2>
      <p className="reading-lock-hint">{needsAccount ? '为保护笔记，请联网验证当前账号的登录密码。' : '离开阅读范围或重新打开应用后，需要再次输入阅读密码。'}</p>
      {needsAccount && <label>账号密码<input type="password" autoComplete="current-password" value={accountPassword} onChange={(e) => setAccountPassword(e.target.value)} required disabled={busy} /></label>}
      {needsNew && <>
        <label>新阅读密码（6～128 个字符）<input type="password" minLength={6} maxLength={128} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy} /></label>
        <label>确认阅读密码<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required disabled={busy} /></label>
      </>}
      {error && <p className="reading-lock-error" role="alert">{error}</p>}
      <div className="dialog-actions"><span className="dialog-spacer" /><button type="button" className="btn-ghost" disabled={busy} onClick={close}>取消</button><button className="btn-primary" disabled={busy} type="submit">{busy ? '正在验证并保存…' : title}</button></div>
    </form>
  </div>
}
