import { useEffect, useState } from 'react'
import { api, session, DEFAULT_SERVER } from '@/lib/api'
import { useStore } from '@/lib/store'
import { isDesktop } from '@/lib/platform'
import { fetchLatestRelease, formatBytes, type UpdateInfo } from '@/lib/update'
import { IconCloud, IconDownload, IconServer } from './Icons'

export function LoginView() {
  const setUser = useStore((s) => s.setUser)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [server, setServer] = useState(session.server)
  const [showServer, setShowServer] = useState(session.server !== DEFAULT_SERVER)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 网页版才查：桌面端用户手里已经有客户端了，没必要再给一个下载链接 */
  const [client, setClient] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    if (isDesktop) return
    let alive = true
    void fetchLatestRelease().then((r) => alive && setClient(r))
    return () => {
      alive = false
    }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    session.server = server.trim() || DEFAULT_SERVER
    try {
      const res =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(email, password, displayName)
      session.save(res.token, res.user)
      setUser(res.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <div className="auth-drag" />
      <div className="auth-center">
        <form className="auth-card" onSubmit={submit}>
          <IconCloud size={26} className="auth-mark" />
          <h1>{mode === 'login' ? '登录云笔记' : '创建账号'}</h1>
          <p className="lede">
            {mode === 'login'
              ? '笔记会在你所有设备之间保持一致。'
              : '一个账号，多台设备，随时接着上一句往下写。'}
          </p>

          {error && <p className="auth-error">{error}</p>}

          <div className="field">
            <label htmlFor="email">邮箱</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          {mode === 'register' && (
            <div className="field">
              <label htmlFor="name">昵称</label>
              <input
                id="name"
                value={displayName}
                placeholder="留空就用邮箱前缀"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? '至少 6 位' : ''}
              required
            />
          </div>

          {showServer ? (
            <div className="field">
              <label htmlFor="server">同步服务地址</label>
              <input id="server" value={server} onChange={(e) => setServer(e.target.value)} />
            </div>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setShowServer(true)} style={{ marginTop: 2 }}>
              <IconServer size={14} />
              换一个同步服务
            </button>
          )}

          <div className="auth-actions">
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? '连接中…' : mode === 'login' ? '登录' : '创建账号'}
            </button>
          </div>

          {client && (
            <a className="auth-download" href={client.downloadUrl} download={client.filename}>
              <IconDownload size={15} />
              下载 Windows 客户端
              <span className="dim">
                v{client.version} · {formatBytes(client.size)}
              </span>
            </a>
          )}

          <p className="auth-switch">
            {mode === 'login' ? '还没有账号？' : '已经有账号了？'}
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login')
                setError('')
              }}
            >
              {mode === 'login' ? '创建一个' : '去登录'}
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
