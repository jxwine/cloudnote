import { useEffect, useState } from 'react'
import { desktop } from '@/lib/platform'
import { formatBytes, type UpdateInfo } from '@/lib/update'

type Phase = 'idle' | 'downloading' | 'verifying' | 'ready'

/**
 * 发现新版本时弹出来。
 *
 * 下载和校验都在主进程做，这里只负责显示进度和把结果交回去。
 * 「以后再说」只是关掉弹窗，不记住选择——下次启动还会问，
 * 因为一个记不住的更新提示比一个烦人的更新提示危害小。
 */
export function UpdateDialog({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [received, setReceived] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!desktop) return
    return desktop.onUpdateProgress((p) => setReceived(p.received))
  }, [])

  useEffect(() => {
    // 下载过程中不给关，免得主进程还在往临时目录写、这边界面已经没了
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase === 'idle') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const start = async () => {
    if (!desktop || phase !== 'idle') return
    setError('')
    setPhase('downloading')
    try {
      const path = await desktop.downloadUpdate(info.downloadUrl, info.sha256)
      setPhase('verifying')
      // 校验在主进程里已经做完了，能拿到路径就说明通过了
      setPhase('ready')
      await desktop.installUpdate(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败')
      setPhase('idle')
      setReceived(0)
    }
  }

  const pct = info.size ? Math.min(100, Math.round((received / info.size) * 100)) : 0
  const busy = phase !== 'idle'

  return (
    <div className="overlay" onMouseDown={() => phase === 'idle' && onClose()}>
      <div className="dialog update-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <label className="dialog-title">有新版本 {info.version}</label>

        {error && <p className="auth-error">{error}</p>}

        {info.notes.trim() ? (
          <pre className="update-notes">{info.notes.trim()}</pre>
        ) : (
          <p className="update-notes is-empty">这个版本没有填写更新说明。</p>
        )}

        <p className="update-meta">
          {info.filename} · {formatBytes(info.size)}
        </p>

        {busy && (
          <div className="update-progress" role="progressbar" aria-valuenow={pct}>
            <div className="update-bar" style={{ width: `${pct}%` }} />
            <span className="update-pct">
              {phase === 'ready' ? '正在启动安装程序…' : `${pct}%`}
            </span>
          </div>
        )}

        <div className="dialog-actions">
          <span className="dialog-spacer" />
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            以后再说
          </button>
          <button type="button" className="btn-primary" onClick={start} disabled={busy}>
            {phase === 'idle' ? '立即更新' : '更新中…'}
          </button>
        </div>

        <p className="update-hint">安装时会先退出云笔记，未保存的改动已经自动同步过了。</p>
      </div>
    </div>
  )
}
