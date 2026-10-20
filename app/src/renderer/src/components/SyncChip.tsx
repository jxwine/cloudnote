import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'
import { IconRefresh } from './Icons'

const LABEL: Record<string, string> = {
  synced: '已同步',
  syncing: '同步中',
  connecting: '连接中',
  offline: '离线',
  error: '同步失败',
  pending: '待同步',
}

const HINT: Record<string, string> = {
  synced: '改动已同步到云端',
  pending: '本地改动等待自动同步，也可点击旁边图标立即同步',
  syncing: '正在同步本地与云端改动',
  connecting: '正在连接同步服务，也可点击旁边图标主动同步',
  offline: '当前离线，请检查网络后点击旁边图标重试',
  error: '同步暂未完成，可点击旁边图标重试',
}

/** 各端共用的同步状态与手动同步入口。 */
export function SyncChip() {
  const status = useStore((s) => s.status)
  const peers = useStore((s) => s.peers)
  const authExpired = useStore((s) => s.authExpired)
  const manualSyncing = useStore((s) => s.manualSyncing)
  const dirty = useStore((s) => s.dirtyNoteId !== null)
  const displayStatus = authExpired ? 'error' : status === 'synced' && dirty ? 'pending' : status
  const label = authExpired ? '登录失效' : LABEL[displayStatus] ?? displayStatus

  return (
    <div className="sync-controls">
      <span
        className="sync-chip"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        title={authExpired || HINT[displayStatus] + (peers > 0 ? `；另有 ${peers} 台设备在线` : '')}
      >
        <span className={`sync-dot ${displayStatus === 'connecting' ? 'syncing' : displayStatus}`} />
        <span>{label}</span>
        {peers > 0 && <span className="peer-badge">{peers + 1} 端</span>}
      </span>
      <button
        className="icon-btn sync-manual"
        type="button"
        disabled={manualSyncing || !!authExpired}
        aria-label={manualSyncing ? '同步中' : '手动同步'}
        aria-busy={manualSyncing}
        title={authExpired ? '请重新登录后同步' : manualSyncing ? '正在手动同步，请稍候' :
          status === 'offline' || status === 'error' ? '重试同步' : '手动同步：立即检查并同步本地与云端改动'}
        onClick={() => void sync.syncManually()}
      >
        <IconRefresh />
      </button>
    </div>
  )
}
