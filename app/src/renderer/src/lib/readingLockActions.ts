import { api, session } from './api'
import { getAccountEpoch } from './accountStorage'
import { useStore } from './store'
import * as sync from './sync'
import { blockedLock, getReadingLock, lockKey, prepareToLock, verifyReadingPassword } from './readingLock'
import type { Folder, LockTarget, Note } from './types'

export async function unlockReadingLock(target: LockTarget, password: string): Promise<void> {
  const before = useStore.getState()
  const blocked = blockedLock(before, target)
  if (!blocked) return
  const lock = getReadingLock(before, blocked)!
  const epoch = getAccountEpoch()
  const valid = await verifyReadingPassword(lock, password)
  const current = useStore.getState()
  const currentBlocked = blockedLock(current, target)
  if (epoch !== getAccountEpoch() || current.lockEpoch !== before.lockEpoch || getReadingLock(current, blocked)?.revision !== lock.revision
    || !currentBlocked || lockKey(currentBlocked) !== lockKey(blocked)) {
    throw new Error('页面或密码已发生变化，请重新解锁')
  }
  if (!valid) throw new Error('阅读密码不正确')
  useStore.setState({ lockGrants: { ...current.lockGrants, [lockKey(blocked)]: lock.revision } })
  if (target.kind === 'folder' && !blockedLock(useStore.getState(), target)) {
    useStore.getState().toggleExpand(target.id, true)
    useStore.setState({ activeFolderId: null })
  }
}

/** 密码永不入离线队列；先结算并确认草稿，成功响应后才改变密码状态。 */
export async function changeReadingLock(target: LockTarget, password: string | null, accountPassword?: string): Promise<void> {
  if (!session.token) throw new Error('请先登录账号')
  if (password !== null && (password.length < 6 || password.length > 128)) throw new Error('阅读密码需为 6～128 个字符')
  const before = useStore.getState()
  const epoch = getAccountEpoch()
  const revision = getReadingLock(before, target)?.revision ?? null
  prepareToLock()
  await sync.syncNow()
  if (epoch !== getAccountEpoch()) throw new Error('账号已切换，请重新操作')
  if (sync.hasPending() || sync.hasQueuedOperations()) throw new Error('还有改动未同步，请联网完成同步后再设置密码')
  if ((getReadingLock(useStore.getState(), target)?.revision ?? null) !== revision) throw new Error('密码已在其他设备更新，请重新操作')
  const entity = await api.setReadingLock(target, { password, accountPassword, baseLockRevision: revision })
  if (epoch !== getAccountEpoch()) return
  prepareToLock()
  // 此刻可能又有输入；同步模块保留新草稿，并立即接受密码元信息。
  if (target.kind === 'note') sync.applyReadingLockNote(entity as Note)
  else useStore.getState().applyFolder(entity as Folder)
  useStore.getState().relock(target)
  useStore.getState().flushCache()
  useStore.getState().showToast({ message: password === null ? '已取消阅读密码' : '阅读密码已保存，已重新上锁' })
}
