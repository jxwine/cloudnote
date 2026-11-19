import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { api, AuthError, NotFoundError } from '@/lib/api'
import { getAccountEpoch } from '@/lib/accountStorage'
import { useStore } from '@/lib/store'
import { onAuthExpired } from '@/lib/sync'
import type { OnlineDevice } from '@/lib/types'
import { IconClose } from './Icons'

const connectionTime = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

export function DevicesDialog({ onDismiss }: { onDismiss: () => void }) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const presenceVersion = useStore((s) => s.presenceVersion)
  const [devices, setDevices] = useState<OnlineDevice[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [target, setTarget] = useState<OnlineDevice | null>(null)
  const [kicking, setKicking] = useState(false)

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  useLayoutEffect(() => {
    if (target) cancelButton.current?.focus()
    else closeButton.current?.focus()
  }, [target])

  useEffect(() => {
    let active = true
    const epoch = getAccountEpoch()
    setLoadError('')
    void api.listDevices().then(({ devices }) => {
      if (active && epoch === getAccountEpoch()) setDevices(devices)
    }).catch((error: unknown) => {
      if (!active || epoch !== getAccountEpoch()) return
      if (error instanceof AuthError) onAuthExpired(error.message)
      else setLoadError(error instanceof NotFoundError ? '当前服务器暂不支持在线设备管理' :
        error instanceof Error ? error.message : '无法获取在线设备')
    })
    return () => { active = false }
  }, [presenceVersion, refresh])

  const kick = async () => {
    if (!target || kicking) return
    const epoch = getAccountEpoch()
    setKicking(true)
    try {
      await api.kickDevice(target.id)
      if (epoch !== getAccountEpoch()) return
      setDevices((list) => list?.filter((device) => device.id !== target.id) ?? null)
      setActionMessage(`已踢出 ${target.name}`)
    } catch (error) {
      if (epoch !== getAccountEpoch()) return
      if (error instanceof AuthError) onAuthExpired(error.message)
      else setActionMessage(error instanceof Error ? error.message : '踢出失败，请重试')
    } finally {
      if (epoch === getAccountEpoch()) {
        setTarget(null)
        setKicking(false)
        setRefresh((value) => value + 1)
      }
    }
  }

  return (
    <dialog ref={dialog} className="dialog devices-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onDismiss() }}>
      <header className="devices-header">
        <h2 id={titleId} className="dialog-title">在线设备</h2>
        <button ref={closeButton} className="icon-btn" type="button" aria-label="关闭在线设备"
          onClick={onDismiss}><IconClose size={17} /></button>
      </header>
      {devices && devices.length > 0 && (
        <ul className="devices-list">
          {devices.map((device) => (
            <li key={device.id} className="device-row">
              <div className="device-info">
                <strong>{device.name}</strong>
                <time dateTime={new Date(device.connectedAt).toISOString()}>连接于 {connectionTime.format(device.connectedAt)}</time>
              </div>
              {device.current ? <span className="device-current">当前端</span> : (
                <button type="button" className="btn-ghost is-danger" disabled={!!target}
                  aria-label={`踢出 ${device.name}`} onClick={() => { setActionMessage(''); setTarget(device) }}>踢出</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {loadError ? (
        <div className="devices-notice" role="status">
          <span>{loadError}</span>
          <button className="btn-ghost" type="button" onClick={() => setRefresh((value) => value + 1)}>重试</button>
        </div>
      ) : !devices || !devices.length ? (
        <p className="devices-notice" role="status">{devices ? '暂时没有在线设备' : '正在获取在线设备…'}</p>
      ) : null}
      {target && (
        <div className="devices-confirm">
          <p>踢出 {target.name} 后，该端需要重新登录。</p>
          <div className="dialog-actions">
            <button ref={cancelButton} className="btn-ghost" type="button" disabled={kicking}
              onClick={() => setTarget(null)}>取消</button>
            <button className="btn-ghost is-danger is-armed" type="button" disabled={kicking}
              onClick={() => void kick()}>{kicking ? '正在踢出…' : '确认踢出'}</button>
          </div>
        </div>
      )}
      {actionMessage && <p className="devices-notice" role="status">{actionMessage}</p>}
    </dialog>
  )
}
