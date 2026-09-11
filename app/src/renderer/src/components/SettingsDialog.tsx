import { useEffect, useState } from 'react'
import { session } from '@/lib/api'
import { isDesktop, desktop } from '@/lib/platform'
import { useStore, type ThemeMode } from '@/lib/store'
import * as sync from '@/lib/sync'
import { downloadClient } from '@/lib/update'
import { PasswordDialog } from './PasswordDialog'
import { IconClose } from './Icons'

type Section = 'general' | 'appearance' | 'account' | 'about'

/* 分类和设置项都由数组/JSX 段落驱动，以后加一类就是加一条，不用动布局 */
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'account', label: '账号' },
  // 「通用」里目前只有开机自启这种桌面端才有的东西，网页版没有内容就不列出来
  ...(isDesktop ? [{ key: 'general' as const, label: '通用' }] : []),
  { key: 'about', label: '关于' },
]

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

interface Props {
  onClose: () => void
  /** 检查更新的结果要弹 UpdateDialog，那个状态在 Workspace 手里，这里只负责触发 */
  onCheckUpdate: () => void
}

/**
 * 设置。
 *
 * 用应用内的面板而不是另开一个窗口：桌面端和网页版是同一份构建，
 * 另开窗口的话网页版还得再写一套。
 */
export function SettingsDialog({ onClose, onCheckUpdate }: Props) {
  const [section, setSection] = useState<Section>('appearance')
  const [changePassword, setChangePassword] = useState(false)
  const [version, setVersion] = useState('')
  /** null = 还没从系统读回来，这段时间开关先禁用，免得点一下又被回读值盖掉 */
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null)

  const themeMode = useStore((s) => s.themeMode)
  const setThemeMode = useStore((s) => s.setThemeMode)
  const user = useStore((s) => s.user)
  const reset = useStore((s) => s.reset)
  const showToast = useStore((s) => s.showToast)

  useEffect(() => {
    void desktop?.info().then((info) => setVersion(info.version))
    void desktop?.getAutoLaunch().then(setAutoLaunch)
  }, [])

  /** 开关显示的是写完后系统里的真实状态，写失败时它会弹回去，再补一句提示 */
  const toggleAutoLaunch = async () => {
    if (!desktop || autoLaunch === null) return
    const want = !autoLaunch
    const actual = await desktop.setAutoLaunch(want)
    setAutoLaunch(actual)
    if (actual !== want) showToast({ message: '没能修改开机自启设置，可能被系统策略或安全软件拦下了' })
  }

  useEffect(() => {
    // 改密码弹窗开着时把 Esc 让给它，否则一下关掉两层
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !changePassword) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, changePassword])

  /** 退出前先把没落库的改动推上去，别让用户丢字 */
  const logout = () => {
    void sync.flushAll().finally(() => {
      sync.stop()
      session.clear()
      reset()
    })
  }

  return (
    <>
      <div className="overlay" onMouseDown={onClose}>
        <div className="dialog settings" onMouseDown={(e) => e.stopPropagation()}>
          <div className="settings-head">
            <span className="dialog-title">设置</span>
            <span className="dialog-spacer" />
            <button className="icon-btn" title="关闭" onClick={onClose}>
              <IconClose size={15} />
            </button>
          </div>

          <div className="settings-body">
            <nav className="settings-nav">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  className={'settings-nav-item' + (section === s.key ? ' is-active' : '')}
                  aria-current={section === s.key}
                  onClick={() => setSection(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </nav>

            <div className="settings-panel">
              {section === 'general' && (
                <Row title="开机自启" hint="开机后自动打开云笔记，登录 Windows 就能接着写">
                  <button
                    role="switch"
                    aria-checked={autoLaunch === true}
                    aria-label="开机自启"
                    className={'switch' + (autoLaunch ? ' is-on' : '')}
                    disabled={autoLaunch === null}
                    onClick={() => void toggleAutoLaunch()}
                  >
                    <span className="switch-knob" />
                  </button>
                </Row>
              )}

              {section === 'appearance' && (
                <Row title="主题" hint="选定后一直记着，下次打开还是这个">
                  <div className="segmented" role="radiogroup" aria-label="主题">
                    {THEME_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        role="radio"
                        aria-checked={themeMode === o.value}
                        className={'segmented-item' + (themeMode === o.value ? ' is-on' : '')}
                        onClick={() => setThemeMode(o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </Row>
              )}

              {section === 'account' && (
                <>
                  <div className="settings-account">
                    <span className="settings-avatar">{(user?.displayName || '?').slice(0, 1)}</span>
                    <span className="settings-row-text">
                      <span className="settings-row-title">{user?.displayName}</span>
                      <span className="settings-row-hint">{user?.email}</span>
                    </span>
                  </div>
                  <Row title="密码" hint="改完不踢下线，其他设备照常用">
                    <button className="btn-ghost" onClick={() => setChangePassword(true)}>
                      修改密码
                    </button>
                  </Row>
                  <Row title="退出登录" hint="本机缓存一并清掉，云端笔记不受影响">
                    <button className="btn-ghost is-danger" onClick={logout}>
                      退出登录
                    </button>
                  </Row>
                </>
              )}

              {section === 'about' && (
                <Row title="云笔记" hint={isDesktop ? `当前版本 ${version || '读取中…'}` : '网页版'}>
                  {isDesktop ? (
                    <button className="btn-ghost" onClick={onCheckUpdate}>
                      检查更新
                    </button>
                  ) : (
                    <button className="btn-ghost" onClick={() => void downloadClient()}>
                      下载 Windows 客户端
                    </button>
                  )}
                </Row>
              )}
            </div>
          </div>
        </div>
      </div>

      {changePassword && <PasswordDialog onClose={() => setChangePassword(false)} />}
    </>
  )
}

/** 一行设置：左边标题加一句人话解释，右边放控件 */
function Row({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      {children}
    </div>
  )
}
