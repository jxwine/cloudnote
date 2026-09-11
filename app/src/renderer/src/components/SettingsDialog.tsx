import { useEffect, useState } from 'react'
import { session } from '@/lib/api'
import { isDesktop, desktop } from '@/lib/platform'
import { useStore, useBindings, TYPOGRAPHY, type ThemeMode } from '@/lib/store'
import {
  SHORTCUTS,
  EDITOR_SHORTCUTS,
  bindingProblem,
  comboFromEvent,
  formatCombo,
  type ShortcutId,
} from '@/lib/shortcuts'
import * as sync from '@/lib/sync'
import { downloadClient } from '@/lib/update'
import { PasswordDialog } from './PasswordDialog'
import { IconClose } from './Icons'

type Section = 'general' | 'appearance' | 'shortcuts' | 'account' | 'about'

/* 分类和设置项都由数组/JSX 段落驱动，以后加一类就是加一条，不用动布局 */
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'shortcuts', label: '快捷键' },
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
  /** 正在录制新组合键的那一条；录制中 Esc 是取消录制，不关设置 */
  const [recording, setRecording] = useState<ShortcutId | null>(null)

  const themeMode = useStore((s) => s.themeMode)
  const setThemeMode = useStore((s) => s.setThemeMode)
  const lineHeight = useStore((s) => s.lineHeight)
  const setLineHeight = useStore((s) => s.setLineHeight)
  const paragraphSpacing = useStore((s) => s.paragraphSpacing)
  const setParagraphSpacing = useStore((s) => s.setParagraphSpacing)
  const bindings = useBindings()
  const overrides = useStore((s) => s.shortcuts)
  const setShortcut = useStore((s) => s.setShortcut)
  const resetShortcuts = useStore((s) => s.resetShortcuts)
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
      if (e.key === 'Escape' && !changePassword && !recording) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, changePassword, recording])

  /**
   * 录制组合键。挂在捕获阶段并截断传播：录制时按下的 Ctrl+N 是「我要绑这个」，
   * 不能真的去新建一篇笔记，也不能让 Tiptap 或上面那个 Esc 处理器看到。
   */
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const combo = comboFromEvent(e)
      if (!combo) {
        // 只按了修饰键是中间态，等着；按了个不带 Ctrl/Alt 的键才需要提醒
        if (!/^(Control|Alt|Shift|Meta)/.test(e.code)) {
          showToast({ message: '要带上 Ctrl 或 Alt，否则会和正常打字冲突' })
        }
        return
      }
      const problem = bindingProblem(bindings, recording, combo)
      if (problem) {
        showToast({ message: problem })
        return
      }
      setShortcut(recording, combo)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, bindings, setShortcut, showToast])

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
                <>
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
                  <Row title="行距" hint="正文每行的高度，拖的时候编辑器里立刻能看到">
                    <Slider
                      label="行距"
                      range={TYPOGRAPHY.lineHeight}
                      value={lineHeight}
                      onChange={setLineHeight}
                    />
                  </Row>
                  <Row title="段间距" hint="段落之间留多少空，标题上下的间距不受影响">
                    <Slider
                      label="段间距"
                      range={TYPOGRAPHY.paragraphSpacing}
                      value={paragraphSpacing}
                      onChange={setParagraphSpacing}
                    />
                  </Row>
                </>
              )}

              {section === 'shortcuts' && (
                <>
                  <Row title="恢复默认" hint="把下面改过的快捷键全部退回默认">
                    <button
                      className="btn-ghost"
                      disabled={Object.keys(overrides).length === 0}
                      onClick={resetShortcuts}
                    >
                      全部恢复默认
                    </button>
                  </Row>
                  {SHORTCUTS.map((def) => {
                    const isRecording = recording === def.id
                    const changed = def.id in overrides
                    return (
                      <Row key={def.id} title={def.label} hint={def.hint}>
                        <div className="shortcut">
                          <button
                            className={'reset-link' + (changed ? ' is-visible' : '')}
                            tabIndex={changed ? 0 : -1}
                            onClick={() => setShortcut(def.id, null)}
                          >
                            默认
                          </button>
                          <button
                            className={'kbd-btn' + (isRecording ? ' is-recording' : '')}
                            title="点击后按下新的组合键"
                            onClick={() => setRecording(isRecording ? null : def.id)}
                            onBlur={() => isRecording && setRecording(null)}
                          >
                            {isRecording ? '按下新的组合键…' : formatCombo(bindings[def.id])}
                          </button>
                        </div>
                      </Row>
                    )
                  })}

                  <div className="settings-group">编辑器内的格式快捷键（内置，不能改）</div>
                  {EDITOR_SHORTCUTS.map((sc) => (
                    <Row key={sc.label} title={sc.label}>
                      <kbd className="kbd">{sc.display ?? formatCombo(sc.combo)}</kbd>
                    </Row>
                  ))}
                </>
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

/** 滑块加数值，偏离默认时多一个「默认」能一键回去 */
function Slider({
  label,
  range,
  value,
  onChange,
}: {
  label: string
  range: { min: number; max: number; step: number; default: number }
  value: number
  onChange: (v: number) => void
}) {
  const isDefault = Math.abs(value - range.default) < 1e-9
  return (
    <div className="slider">
      <button
        className={'reset-link' + (isDefault ? '' : ' is-visible')}
        tabIndex={isDefault ? -1 : 0}
        onClick={() => onChange(range.default)}
      >
        默认
      </button>
      <input
        type="range"
        aria-label={label}
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{value.toFixed(1)}</span>
    </div>
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
