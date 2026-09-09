import { useCallback, useEffect, useRef, useState } from 'react'
import { api, uploadRelease } from '@/lib/api'
import { useStore } from '@/lib/store'
import { formatBytes } from '@/lib/update'
import type { Release } from '@/lib/types'
import { IconUpload } from '../Icons'

/** 从 electron-builder 的产物名里猜版本号：「云笔记 Setup 1.2.0.exe」→ 1.2.0 */
const guessVersion = (filename: string) => /(\d+\.\d+\.\d+)/.exec(filename)?.[1] ?? ''

const fmtDate = (t: number) => {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function AdminReleases() {
  const [rows, setRows] = useState<Release[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const showToast = useStore((s) => s.showToast)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows((await api.adminReleases()).releases)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const togglePublished = async (r: Release) => {
    try {
      await api.adminSetRelease(r.id, { published: !r.published })
      showToast({ message: r.published ? `${r.version} 已下架` : `${r.version} 已上架` })
      void load()
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : '操作失败' })
    }
  }

  const remove = async (r: Release) => {
    try {
      await api.adminDeleteRelease(r.id)
      showToast({ message: `已删除 ${r.version}` })
      void load()
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : '删除失败' })
    }
  }

  return (
    <div className="admin-section">
      <UploadForm onDone={load} />

      {error && <p className="auth-error">{error}</p>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>版本</th>
              <th>文件</th>
              <th className="num">大小</th>
              <th>发布时间</th>
              <th>状态</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.published ? '' : 'is-disabled'}>
                <td>
                  <div className="admin-user">
                    <span className="admin-user-name">{r.version}</span>
                    <span className="admin-user-mail">{r.platform}</span>
                  </div>
                </td>
                <td className="admin-file">
                  <span title={r.filename}>{r.filename}</span>
                  <code title={'sha256 ' + r.sha256}>{r.sha256.slice(0, 12)}…</code>
                </td>
                <td className="num">{formatBytes(r.size)}</td>
                <td className="dim">{fmtDate(r.createdAt)}</td>
                <td>
                  {r.published ? (
                    <span className="admin-tag is-live">已发布</span>
                  ) : (
                    <span className="admin-tag is-off">已下架</span>
                  )}
                </td>
                <td className="admin-row-actions">
                  <button className="btn-ghost" onClick={() => void togglePublished(r)}>
                    {r.published ? '下架' : '上架'}
                  </button>
                  <button className="btn-ghost is-danger" onClick={() => void remove(r)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="tree-empty">
                  还没有发布过任何版本
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.some((r) => r.published) && (
        <p className="admin-hint">
          客户端拿<b>最近发布</b>的那条已发布版本和自己比——按发布时间排，不是按版本号大小，
          所以想回滚只要把旧版本重新传一次。客户端只会往高版本更新，不会被降级。
          同一个版本号只能存在一条，要重发得先删掉旧的那条。
        </p>
      )}
    </div>
  )
}

function UploadForm({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [version, setVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [sent, setSent] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const showToast = useStore((s) => s.showToast)

  const [dragging, setDragging] = useState(false)

  const pick = (f: File | null) => {
    if (f && !/\.exe$/i.test(f.name)) {
      setError(`只能上传 .exe 安装包，这个是「${f.name}」`)
      return
    }
    setFile(f)
    setError('')
    // 版本号能从文件名猜出来就填上，猜不出来让人自己写
    if (f && !version) setVersion(guessVersion(f.name))
  }

  /*
   * 拖到窗口任意位置都别让浏览器接管——默认行为是直接打开那个文件，
   * 等于把后台页面导航走，填了一半的更新说明全没了。
   * 只 preventDefault、不 stopPropagation：拖拽区自己的 handler 在冒泡链上更靠前，照常触发。
   */
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = Array.from(e.dataTransfer.files)
    if (dropped.length > 1) {
      setError('一次只能传一个安装包')
      return
    }
    if (dropped[0]) pick(dropped[0])
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !file) return
    setBusy(true)
    setError('')
    setSent(0)
    try {
      const r = await uploadRelease(file, { version: version.trim(), notes }, (s) => setSent(s))
      showToast({ message: `${r.version} 已发布，客户端下次检查更新就能看到` })
      setFile(null)
      setVersion('')
      setNotes('')
      if (inputRef.current) inputRef.current.value = ''
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  const pct = file && file.size ? Math.min(100, Math.round((sent / file.size) * 100)) : 0

  return (
    <form className="admin-upload" onSubmit={submit}>
      <div className="admin-upload-head">
        <IconUpload size={16} />
        <b>发布新版本</b>
      </div>

      {error && <p className="auth-error">{error}</p>}

      <div
        className={'admin-drop' + (dragging ? ' is-over' : '') + (file ? ' has-file' : '')}
        onDragEnter={(e) => {
          e.preventDefault()
          if (!busy) setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          // 拖过内部子元素时也会冒 dragleave，用 relatedTarget 判断是不是真的离开了整块区域
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={busy ? undefined : onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
        }}
      >
        <input
          id="rel-file"
          ref={inputRef}
          type="file"
          accept=".exe"
          hidden
          disabled={busy}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        <IconUpload size={22} />
        {file ? (
          <>
            <b className="admin-drop-name">{file.name}</b>
            <span className="admin-drop-hint">{formatBytes(file.size)} · 点这里或再拖一个换掉</span>
          </>
        ) : (
          <>
            <b className="admin-drop-name">把安装包拖到这里</b>
            <span className="admin-drop-hint">或者点一下选择文件 · 只收 .exe</span>
          </>
        )}
      </div>

      <div className="admin-upload-grid">
        <div className="field">
          <label htmlFor="rel-version">版本号</label>
          <input
            id="rel-version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="1.2.0"
            disabled={busy}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="rel-notes">更新说明</label>
        <textarea
          id="rel-notes"
          rows={4}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={'这里写的内容会原样显示在用户的更新提示里。\n一行一条，别写「优化若干问题」。'}
          disabled={busy}
        />
      </div>

      {busy && (
        <div className="update-progress">
          <div className="update-bar" style={{ width: `${pct}%` }} />
          <span className="update-pct">{pct}%</span>
        </div>
      )}

      <div className="dialog-actions">
        <span className="dialog-spacer" />
        <button type="submit" className="btn-primary" disabled={busy || !file || !version.trim()}>
          {busy ? '上传中…' : '发布'}
        </button>
      </div>
    </form>
  )
}
