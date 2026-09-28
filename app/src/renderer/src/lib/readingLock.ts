import type { Folder, Note, LockTarget, ReadingLock } from './types'

export interface LockState {
  folders: Record<string, Folder>
  notes: Record<string, Note>
  lockGrants: Record<string, string>
}

export const lockKey = (target: LockTarget) => `${target.kind}:${target.id}`
export const getReadingLock = (state: LockState, target: LockTarget): ReadingLock | null =>
  (target.kind === 'folder' ? state.folders[target.id] : state.notes[target.id])?.readingLock ?? null

/** 由外向内校验，软删除的祖先仍参与保护回收站里的内容。 */
export function lockChain(state: LockState, target: LockTarget): LockTarget[] {
  const chain: LockTarget[] = []
  let cursor = target.kind === 'folder' ? target.id : state.notes[target.id]?.folderId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const folder = state.folders[cursor]
    if (!folder) break
    if (folder.readingLock) chain.unshift({ kind: 'folder', id: cursor })
    cursor = folder.parentId
  }
  if (target.kind === 'note' && state.notes[target.id]?.readingLock) chain.push(target)
  return chain
}

export const blockedLock = (state: LockState, target: LockTarget): LockTarget | null =>
  lockChain(state, target).find((item) => state.lockGrants[lockKey(item)] !== getReadingLock(state, item)?.revision) ?? null
export const hasReadingLock = (state: LockState, target: LockTarget) => lockChain(state, target).length > 0
export const canReadNote = (state: LockState, note: Note) => !blockedLock(state, { kind: 'note', id: note.id })

/** 仅用于展示，不能写回实体；短标题也至少隐藏一个字符。 */
export function maskReadingTitle(title: string): string {
  const chars = Array.from(title.trim())
  if (chars.length <= 1) return '*'
  if (chars.length === 2) return `${chars[0]}*`
  return `${chars[0]}**${chars[chars.length - 1]}`
}

export function readingTitle(state: LockState, target: LockTarget): string {
  const item = target.kind === 'folder' ? state.folders[target.id] : state.notes[target.id]
  const title = item ? ('name' in item ? item.name : item.title).trim() || '无标题' : '无标题'
  const blocking = blockedLock(state, target)
  if (!blocking) return title
  if (lockKey(blocking) !== lockKey(target)) return target.kind === 'folder' ? '受密码保护的目录' : '受密码保护的笔记'
  return maskReadingTitle(title)
}

/** 只保留下一个目标范围内有效的授权，绝不持久化或同步。 */
export function retainedGrants(state: LockState, target: LockTarget | null): Record<string, string> {
  const grants: Record<string, string> = {}
  if (target) for (const item of lockChain(state, target)) {
    const key = lockKey(item)
    const revision = getReadingLock(state, item)?.revision
    if (revision && state.lockGrants[key] === revision) grants[key] = revision
  }
  return grants
}

// 先结算输入法及标题，再收起编辑器；同步模块注册，避免 store 与 sync 循环导入。
const beforeLock = new Set<() => void>()
export function onBeforeLock(fn: () => void) { beforeLock.add(fn); return () => { beforeLock.delete(fn) } }
export function prepareToLock() { for (const fn of beforeLock) fn() }

export async function verifyReadingPassword(lock: ReadingLock, password: string): Promise<boolean> {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持密码验证，请使用 HTTPS 或桌面客户端')
  if (lock.iterations !== 210000 || !/^[a-f0-9]{32}$/i.test(lock.salt) || !/^[a-f0-9]{64}$/i.test(lock.hash)) {
    throw new Error('密码数据无效，请联网同步后重试')
  }
  const salt = Uint8Array.from(lock.salt.match(/../g)!, (hex) => parseInt(hex, 16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: lock.iterations, hash: 'SHA-256' }, key, 256)
  const hash = Array.from(new Uint8Array(bits), (v) => v.toString(16).padStart(2, '0')).join('')
  return hash === lock.hash
}
