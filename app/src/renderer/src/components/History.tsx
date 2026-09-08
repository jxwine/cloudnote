import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useStore } from '@/lib/store'
import { htmlToMarkdown } from '@/lib/markdown'
import type { Note, Revision } from '@/lib/types'
import { IconClose, IconHistory, IconRestore } from './Icons'

const stamp = (ts: number) => {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 历史版本：左边一列时间点，右边预览那一版的内容 */
export function History({ note, onClose }: { note: Note; onClose: () => void }) {
  const [list, setList] = useState<Revision[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [preview, setPreview] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const showToast = useStore((s) => s.showToast)
  const applyNote = useStore((s) => s.applyNote)

  useEffect(() => {
    api
      .revisions(note.id)
      .then((r) => {
        setList(r.revisions)
        if (r.revisions[0]) setPicked(r.revisions[0].id)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '读取历史失败'))
  }, [note.id])

  useEffect(() => {
    if (!picked) return
    setPreview('')
    api
      .revision(picked)
      .then((r) => setPreview(htmlToMarkdown(r.content) || '（这一版是空的）'))
      .catch(() => setPreview('读取失败'))
  }, [picked])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const restore = async () => {
    if (!picked || busy) return
    setBusy(true)
    try {
      const restored = await api.restoreRevision(picked)
      applyNote(restored)
      showToast({ message: '已恢复到该版本，当前内容也已存为一个版本，可以再退回来' })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复失败')
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="history" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-head">
          <IconHistory size={16} />
          <span className="history-title">{note.title?.trim() || '无标题'} · 历史版本</span>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>

        {error && <p className="auth-error">{error}</p>}

        <div className="history-body">
          <div className="history-list">
            {list === null ? (
              <div className="tree-empty">读取中…</div>
            ) : list.length ? (
              list.map((rev) => (
                <button
                  key={rev.id}
                  className={'history-item' + (rev.id === picked ? ' is-active' : '')}
                  onClick={() => setPicked(rev.id)}
                >
                  <span className="history-when">{stamp(rev.createdAt)}</span>
                  <span className="history-meta">
                    第 {rev.version} 版 · {Math.max(1, Math.round(rev.size / 100) / 10)} KB
                  </span>
                </button>
              ))
            ) : (
              <div className="tree-empty">
                还没有历史版本。
                <br />
                每隔几分钟的改动会自动留一版。
              </div>
            )}
          </div>

          <div className="history-preview">
            <pre>{preview}</pre>
          </div>
        </div>

        <div className="history-foot">
          <span className="history-hint">恢复后当前内容也会存成一个版本，随时能退回来。</span>
          <button className="btn-primary" disabled={!picked || busy} onClick={restore}>
            <IconRestore size={15} />
            {busy ? '恢复中…' : '恢复到这一版'}
          </button>
        </div>
      </div>
    </div>
  )
}
