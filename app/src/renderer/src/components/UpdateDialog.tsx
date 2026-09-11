import { useEffect, useState } from 'react'
import { desktop } from '@/lib/platform'
import { formatBytes, type UpdateInfo } from '@/lib/update'

type Phase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'restart'

/** 主进程抛的错经过 IPC 会被包一层「Error invoking remote method …」，用户不需要看这个 */
const cleanMessage = (err: unknown) =>
  (err instanceof Error ? err.message : '更新失败').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * 发现新版本时弹出来。
 *
 * 下载和校验都在主进程做，这里只负责显示进度和把结果交回去。
 * 「以后再说」只是关掉弹窗，不记住选择——下次启动还会问，
 * 因为一个记不住的更新提示比一个烦人的更新提示危害小。
 *
 * 两种包走两条路：整包下完直接拉起安装程序；热更新包（2 MB）下完只需重启，
 * 也可以先不重启——包已经落在本机了，下次启动自然生效。
 */
export function UpdateDialog({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [received, setReceived] = useState(0)
  const [error, setError] = useState('')
  const isHot = info.kind === 'hot'

  useEffect(() => {
    if (!desktop) return
    return desktop.onUpdateProgress((p) => setReceived(p.received))
  }, [])

  useEffect(() => {
    // 下载过程中不给关，免得主进程还在往临时目录写、这边界面已经没了
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (phase === 'idle' || phase === 'restart')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const start = async () => {
    if (!desktop || phase !== 'idle') return
    setError('')
    setPhase('downloading')
    try {
      if (isHot) {
        await desktop.downloadHotUpdate(info.downloadUrl, info.sha256, info.version)
        // 校验在主进程里已经做完了，能返回就说明通过了；接下来由用户决定何时重启
        setPhase('restart')
        return
      }
      const path = await desktop.downloadUpdate(info.downloadUrl, info.sha256)
      setPhase('verifying')
      setPhase('ready')
      await desktop.installUpdate(path)
    } catch (err) {
      setError(cleanMessage(err))
      setPhase('idle')
      setReceived(0)
    }
  }

  const pct = info.size ? Math.min(100, Math.round((received / info.size) * 100)) : 0
  const busy = phase === 'downloading' || phase === 'verifying' || phase === 'ready'
  const canClose = phase === 'idle' || phase === 'restart'

  return (
    <div className="overlay" onMouseDown={() => canClose && onClose()}>
      <div className="dialog update-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <label className="dialog-title">有新版本 {info.version}</label>

        {error && <p className="auth-error">{error}</p>}

        {info.notes.trim() ? (
          <pre className="update-notes">{info.notes.trim()}</pre>
        ) : (
          <p className="update-notes is-empty">这个版本没有填写更新说明。</p>
        )}

        <p className="update-meta">
          {isHot ? '热更新' : info.filename} · {formatBytes(info.size)}
        </p>

        {busy && (
          <div className="update-progress" role="progressbar" aria-valuenow={pct}>
            <div className="update-bar" style={{ width: `${pct}%` }} />
            <span className="update-pct">
              {phase === 'ready' ? '正在启动安装程序…' : `${pct}%`}
            </span>
          </div>
        )}

        {phase === 'restart' ? (
          <>
            <div className="dialog-actions">
              <span className="dialog-spacer" />
              <button type="button" className="btn-ghost" onClick={onClose}>
                下次启动生效
              </button>
              <button type="button" className="btn-primary" onClick={() => void desktop?.applyHotUpdate()}>
                立即重启
              </button>
            </div>
            <p className="update-hint">已经下载好了。重启只要几秒，未保存的改动已经自动同步过了。</p>
          </>
        ) : (
          <>
            <div className="dialog-actions">
              <span className="dialog-spacer" />
              <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
                以后再说
              </button>
              <button type="button" className="btn-primary" onClick={start} disabled={busy}>
                {phase === 'idle' ? '立即更新' : '更新中…'}
              </button>
            </div>
            <p className="update-hint">
              {isHot
                ? '只下载改动的部分，几秒钟就好，下载完重启一次即可。'
                : '安装时会先退出云笔记，未保存的改动已经自动同步过了。'}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
