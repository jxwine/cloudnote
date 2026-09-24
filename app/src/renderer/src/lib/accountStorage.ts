/**
 * 活动账号继续使用旧版的三个 localStorage 键。切换账号时将其存档，
 * 再把目标账号的存档恢复到这三个键，避免旧数据被新账号读取或发送。
 */
export type AccountScope = { server: string; userId: string }

const SCOPE_KEY = 'cloudnote.scope'
const SWITCH_KEY = 'cloudnote.scopeSwitch'
const ARCHIVE_PREFIX = 'cloudnote.account.'
const ACTIVE_KEYS = ['cloudnote.cache', 'cloudnote.pending', 'cloudnote.queue'] as const
type ActiveKey = typeof ACTIVE_KEYS[number]
type Snapshot = Record<ActiveKey, string | null>

let accountEpoch = 0

const normalizeServer = (server: string) => server.trim().replace(/\/+$/, '')
const scopeId = (scope: AccountScope) => JSON.stringify([scope.server, scope.userId])
const archiveKey = (scope: AccountScope) => ARCHIVE_PREFIX + encodeURIComponent(scopeId(scope))

function validScope(value: unknown): value is AccountScope {
  if (!value || typeof value !== 'object') return false
  const scope = value as Partial<AccountScope>
  return typeof scope.server === 'string' && !!scope.server &&
    typeof scope.userId === 'string' && !!scope.userId
}

function readScope(): AccountScope | null {
  const raw = localStorage.getItem(SCOPE_KEY)
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return validScope(value) ? value : null
  } catch {
    return null
  }
}

function snapshot(): Snapshot {
  return Object.fromEntries(ACTIVE_KEYS.map((key) => [key, localStorage.getItem(key)])) as Snapshot
}

function restore(values: Snapshot | null) {
  for (const key of ACTIVE_KEYS) {
    const value = values?.[key]
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  }
}

function readArchive(scope: AccountScope): Snapshot | null {
  const raw = localStorage.getItem(archiveKey(scope))
  if (!raw) return null
  const values: unknown = JSON.parse(raw)
  if (!values || typeof values !== 'object') throw new Error('账号本地存档已损坏，无法安全切换')
  const record = values as Record<string, unknown>
  for (const key of ACTIVE_KEYS) {
    if (record[key] !== null && typeof record[key] !== 'string') {
      throw new Error('账号本地存档已损坏，无法安全切换')
    }
  }
  return record as Snapshot
}

/** 上次切换若在写活动键的中途崩溃，从已存档的目标快照完成切换。 */
function recoverInterruptedSwitch() {
  const raw = localStorage.getItem(SWITCH_KEY)
  if (!raw) return
  const target: unknown = JSON.parse(raw)
  if (!validScope(target)) throw new Error('账号切换记录已损坏，无法安全读取本地数据')
  restore(readArchive(target))
  localStorage.setItem(SCOPE_KEY, JSON.stringify(target))
  localStorage.removeItem(SWITCH_KEY)
  invalidateAccountEpoch()
}

/** 旧版无 scope 标记时，按当时存下的账号和服务器认领活动数据。 */
export function initializeAccountScope(defaultServer: string) {
  recoverInterruptedSwitch()
  if (readScope()) return
  const rawUser = localStorage.getItem('cloudnote.user')
  if (!rawUser) return
  let user: unknown
  try {
    user = JSON.parse(rawUser)
  } catch {
    // 损坏的旧账号记录不能作为数据归属依据。
    return
  }
  const id = (user as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !id) return
  const server = normalizeServer(localStorage.getItem('cloudnote.server') || defaultServer)
  localStorage.setItem(SCOPE_KEY, JSON.stringify({ server, userId: id }))
}

export const getActiveAccountScope = () => readScope()
export const getAccountEpoch = () => accountEpoch
export function invalidateAccountEpoch() { return ++accountEpoch }

/**
 * 同步切换活动账号。先存档旧数据，存档失败时不改活动键；同账号重登不搬动数据。
 * 调用方应先停掉旧同步并清理内存中的待发请求/定时器，再重载 store。
 */
export function activateAccountScope(server: string, userId: string): { changed: boolean; epoch: number } {
  const next: AccountScope = { server: normalizeServer(server), userId }
  if (!next.server || !next.userId) throw new Error('缺少账号归属信息')
  const current = readScope()
  if (current && scopeId(current) === scopeId(next)) {
    return { changed: false, epoch: accountEpoch }
  }

  const target = readArchive(next)
  const old = snapshot()
  if (current) {
    // 不吞配额错误；只有旧账号存档成功，才允许搬走活动键。
    localStorage.setItem(archiveKey(current), JSON.stringify(old))
  } else if (Object.values(old).some((value) => value !== null)) {
    // 无法辨认归属的旧数据也要保住，但绝不能自动归给新账号。
    localStorage.setItem(ARCHIVE_PREFIX + 'unclaimed.' + Date.now(), JSON.stringify(old))
  }

  // 先立恢复标记，再逐项更换活动键；崩溃后启动会完成目标快照的恢复。
  localStorage.setItem(SWITCH_KEY, JSON.stringify(next))
  try {
    restore(target)
    localStorage.setItem(SCOPE_KEY, JSON.stringify(next))
  } catch (error) {
    // 本次切换没成功时，恢复旧活动数据与归属。
    restore(old)
    if (current) localStorage.setItem(SCOPE_KEY, JSON.stringify(current))
    else localStorage.removeItem(SCOPE_KEY)
    localStorage.removeItem(SWITCH_KEY)
    throw error
  }
  localStorage.removeItem(SWITCH_KEY)
  return { changed: true, epoch: invalidateAccountEpoch() }
}
