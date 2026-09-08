import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'

const LABEL: Record<string, string> = {
  synced: '已同步',
  syncing: '同步中',
  connecting: '连接中',
  offline: '离线',
  error: '同步失败',
}

/** 标题栏右侧的同步状态。离线或出错时点一下重试。 */
export function SyncChip() {
  const status = useStore((s) => s.status)
  const peers = useStore((s) => s.peers)

  const retryable = status === 'offline' || status === 'error'

  return (
    <button
      className="sync-chip"
      title={
        retryable
          ? '点击重新连接同步服务'
          : peers > 0
            ? `另有 ${peers} 台设备在线，改动会实时互通`
            : '改动会自动保存到云端'
      }
      onClick={() => {
        if (!retryable) return
        sync.stop()
        sync.start()
      }}
    >
      <span className={`sync-dot ${status === 'connecting' ? 'syncing' : status}`} />
      <span>{LABEL[status] ?? status}</span>
      {peers > 0 && <span className="peer-badge">{peers + 1} 端</span>}
    </button>
  )
}
