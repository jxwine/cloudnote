import { api, session, clientId, AuthError, ConflictError, OfflineError, newLocalId } from './api'
import { useStore } from './store'
import type { Note } from './types'
import { activateAccountScope, getAccountEpoch, invalidateAccountEpoch } from './accountStorage'

const QUEUE_KEY = 'cloudnote.queue'
const PENDING_KEY = 'cloudnote.pending'
const SAVE_DEBOUNCE = 700
/** 一直不停手也不能永远不保存，同一篇最多攒这么久就强制发一次 */
const SAVE_MAX_WAIT = 5000
/** 同一篇连续失败这么多次就放弃，别让它一直卡在待保存里 */
const MAX_SAVE_RETRY = 3

/* ------------------------------------------------------------------ *
 * 冲突策略
 * ------------------------------------------------------------------
 * 本地正在编辑的内容永远保留在原笔记上；与之冲突的云端版本会被完整
 * 归档成一条「冲突副本」笔记，并在界面上给出提示。这样多端同时改同
 * 一篇笔记时，两个版本都不会丢，用户自己决定怎么合并。
 * ------------------------------------------------------------------ */

type QueuedOp =
  | { kind: 'folder.create'; id: string; name: string; parentId: string | null; sortOrder: number }
  | { kind: 'folder.update'; id: string; name?: string; parentId?: string | null; sortOrder?: number }
  | { kind: 'folder.delete'; id: string }
  | { kind: 'note.create'; id: string; folderId: string | null; title: string; content: string; excerpt: string; sortOrder: number; conflictOf?: string | null }
  | { kind: 'note.delete'; id: string }

const store = () => useStore.getState()

let ws: WebSocket | null = null
let retry = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let stopped = true

type Patch = Partial<Pick<Note, 'title' | 'content' | 'excerpt' | 'folderId' | 'sortOrder' | 'tags' | 'deleted'>>

/**
 * 每篇笔记待落库的改动。必须落到 localStorage：只放内存里的话，
 * 编辑后 700ms 内关掉应用（或离线时新建又编辑）内容就没了——
 * beforeunload 里的网络请求根本来不及发出去。
 */
const pendingSaves = new Map<string, Patch>()
let draftsLoaded = false
let accountSuspended = false
let pendingReadBlocked = false
let backedUpCorruptPending: string | null = null
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const saveFailures = new Map<string, number>()
/** 这一批待保存的改动最早是什么时候攒下的，用来兜住 SAVE_MAX_WAIT */
const saveSince = new Map<string, number>()
/** 正在发请求的笔记，防止同一篇并发两个 PATCH */
const savingNotes = new Map<string, Promise<void>>()
const pendingBases = new Map<string, number>()
let syncTask: Promise<void> | null = null
let syncAgain = false
let replayTask: Promise<void> | null = null
/** 请求在途期间也保留草稿；第三项携带恢复所需的基准与笔记，兼容旧的二元组。 */
function persistPending(): boolean {
  // 旧草稿损坏且还没有安全备份时，绝不能用新草稿覆盖唯一的原文。
  if (pendingReadBlocked) return false
  if (!draftsLoaded) return true
  try {
    if (pendingSaves.size) {
      localStorage.setItem(PENDING_KEY, JSON.stringify([...pendingSaves].map(([id, patch]) =>
        [id, patch, {
          baseVersion: pendingBases.get(id),
          // patch 已含正文时只留元数据；恢复时会由 patch 补回正文。
          note: patch.content === undefined ? store().notes[id] :
            store().notes[id] && { ...store().notes[id], content: undefined },
        }]
      )))
    } else localStorage.removeItem(PENDING_KEY)
    return true
  } catch {
    store().setStatus('error')
    store().showToast({ message: '本机存储空间不足，草稿尚未写入本机，请保持应用打开并导出备份' })
    return false
  }
}

function restorePending() {
  try {
    const entries = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]') as [string, Patch, { baseVersion?: number; note?: Note }?][]
    for (const [id, patch, recovery] of entries) {
      if (pendingSaves.has(id)) continue
      const local = store().notes[id] ?? recovery?.note
      pendingSaves.set(id, patch)
      pendingBases.set(id, recovery?.baseVersion ?? local?.version ?? 1)
      if (local) store().applyNote({ ...local, ...patch })
    }
    draftsLoaded = true
    pendingReadBlocked = false
    store().setDirty(pendingSaves.keys().next().value ?? null)
  } catch {
    // 先留下损坏数据的原文，之后的新编辑才允许写回 PENDING_KEY。
    try {
      const raw = localStorage.getItem(PENDING_KEY)
      if (raw !== null && raw !== backedUpCorruptPending) {
        localStorage.setItem(`${PENDING_KEY}.corrupt.${Date.now()}.${Math.random().toString(36).slice(2)}`, raw)
        backedUpCorruptPending = raw
      }
      pendingReadBlocked = false
      store().showToast({ message: '本机草稿读取失败，原始数据已备份，请检查本机数据' })
    } catch {
      pendingReadBlocked = true
      store().showToast({ message: '本机草稿读取失败且无法备份，请保持应用打开并导出本机数据' })
    }
  }
}

/** noteId → 最近一次归档出的冲突副本，短时间内的连续冲突复用同一条副本 */
const activeArchive = new Map<string, { copyId: string; at: number }>()
/** 同一篇笔记的归档排成一条队，避免并发时建出多条相同的冲突副本 */
const archiveChain = new Map<string, Promise<unknown>>()
/** 本端最近一次保存成功的时刻，用来识别「刚存完就被别人的版本盖掉」 */
const recentSave = new Map<string, number>()
const RECENT_SAVE_MS = 30_000
const ARCHIVE_REUSE_MS = 60_000

/* ---------------- 离线操作队列 ---------------- */

function loadQueue(): QueuedOp[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') as QueuedOp[]
  } catch {
    return []
  }
}
function saveQueue(q: QueuedOp[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
}
function enqueue(op: QueuedOp) {
  saveQueue([...loadQueue(), op])
}

function replayQueue(): Promise<void> {
  if (replayTask) return replayTask
  const epoch = getAccountEpoch()
  const task = Promise.resolve().then(async () => {
    while (epoch === getAccountEpoch() && session.token) {
      const op = loadQueue()[0]
      if (!op) break
      try {
        await runOp(op, epoch)
      } catch (err) {
        if (epoch !== getAccountEpoch()) return
        if (err instanceof AuthError) onAuthExpired(err.message)
        else store().setStatus(err instanceof OfflineError ? 'offline' : 'error')
        // 未确认的操作留在队列，包括服务端暂时失败；不能静默丢弃。
        return
      }
      if (epoch !== getAccountEpoch()) return
      const current = loadQueue()
      // 操作执行期间可能追加了新项，只移除这次确认的项。
      const index = current.findIndex((item) => JSON.stringify(item) === JSON.stringify(op))
      if (index >= 0) current.splice(index, 1)
      saveQueue(current)
    }
  }).finally(() => { if (replayTask === task) replayTask = null })
  replayTask = task
  return task
}

async function runOp(op: QueuedOp, epoch: number) {
  const current = () => epoch === getAccountEpoch()
  switch (op.kind) {
    case 'folder.create': {
      const folder = await api.createFolder(op)
      if (current()) store().applyFolder(folder)
      break
    }
    case 'folder.update': {
      const folder = await api.updateFolder(op.id, { name: op.name, parentId: op.parentId, sortOrder: op.sortOrder })
      if (current()) store().applyFolder(folder)
      break
    }
    case 'folder.delete': {
      const res = await api.deleteFolder(op.id)
      if (current()) {
        store().applyBatch(res.folders, [])
        res.notes.forEach(onRemoteNote)
      }
      break
    }
    case 'note.create': {
      let saved: Note
      try { saved = await api.createNote(op) }
      catch (err) {
        if (!current() || err instanceof OfflineError || err instanceof AuthError) throw err
        // 请求已成功但回执丢失时，相同 id 的创建会失败；回读确认后再出队。
        const existing = (await api.pull(0)).notes.find((n) => n.id === op.id)
        if (!existing) throw err
        saved = existing
      }
      if (current()) {
        const draft = pendingSaves.get(op.id)
        store().applyNote({ ...saved, ...draft })
        if (draft) {
          // 已存在的记录可能来自请求回执丢失，仍须保留原基准以便检测冲突。
          if (!pendingBases.has(op.id)) pendingBases.set(op.id, saved.version)
          persistPending()
        }
      }
      break
    }
    case 'note.delete': {
      const saved = await api.deleteNote(op.id)
      if (current()) onRemoteNote(saved)
      break
    }
  }
}

/* ---------------- 连接与拉取 ---------------- */

export function start() {
  if (!session.token) return
  accountSuspended = false
  stopped = false
  restorePending()
  connectWs()
  void syncNow()
}

/** 启动、焦点、重连共用同一轮对账，先补建，再提交草稿，再拉取。 */
export function syncNow(): Promise<void> {
  if (syncTask) {
    // 网络恢复时，旧一轮可能仍在等待即将失败的请求；保留这次重跑意图。
    syncAgain = true
    return syncTask
  }
  const epoch = getAccountEpoch()
  const task = Promise.resolve().then(async () => {
    if (!session.token) return
    do {
      syncAgain = false
      await replayQueue()
      if (epoch !== getAccountEpoch()) return
      await flushAll()
      if (epoch !== getAccountEpoch()) return
      await pullDelta()
    } while (syncAgain && epoch === getAccountEpoch() && session.token)
  }).finally(() => { if (syncTask === task) syncTask = null })
  syncTask = task
  return task
}

export function stop() {
  stopped = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  ws?.close()
  ws = null
  store().setStatus('offline', 0)
}

function connectWs() {
  if (stopped || !session.token) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  store().setStatus('connecting')
  const url = session.server.replace(/^http/, 'ws') + `/ws?token=${session.token}&clientId=${clientId}`
  const socket = new WebSocket(url)
  ws = socket

  socket.onopen = () => {
    if (ws !== socket || stopped) return
    retry = 0
    void syncNow()
  }

  socket.onmessage = (ev) => {
    if (ws !== socket || stopped) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(ev.data as string)
    } catch {
      return
    }
    handleMessage(msg)
  }

  socket.onclose = () => {
    if (ws !== socket) return
    ws = null
    if (stopped) return
    store().setStatus('offline', 0)
    scheduleReconnect()
  }

  socket.onerror = () => socket.close()
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  const delay = Math.min(15_000, 800 * 2 ** retry++)
  reconnectTimer = setTimeout(connectWs, delay)
}

function handleMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'ready':
      store().setStatus(hasPending() || loadQueue().length ? 'syncing' : 'synced', (msg.peers as number) ?? 0)
      break
    case 'presence':
      store().setStatus(store().status === 'offline' ? 'synced' : store().status, Math.max(0, ((msg.peers as number) ?? 1) - 1))
      break
    case 'folder:upsert':
      store().applyFolder(msg.folder as never)
      break
    case 'note:upsert':
      onRemoteNote(msg.note as Note)
      break
    case 'note:purged': {
      // 别端彻底删了它，本地连墓碑一起清掉
      const id = msg.id as string
      pendingSaves.delete(id)
      persistPending()
      store().dropLocal('note', id)
      break
    }
  }
}

/**
 * 收到其他设备推来的笔记改动：
 * - 这篇笔记本地没有未保存改动 → 直接热更新，用户正在浏览就能立刻看到
 * - 本地正在编辑 → 把云端版本归档成冲突副本，本地内容原样保留
 */
function onRemoteNote(remote: Note): boolean {
  const s = store()
  const local = s.notes[remote.id]
  if (local && remote.version <= local.version) return true
  // 在途请求也是草稿；接收远端消息不能改变它的基准版本。
  // 等提交时由服务端 409 返回最新内容，归档成功后才允许覆盖。
  if (pendingSaves.has(remote.id)) return false
  if (Date.now() - (recentSave.get(remote.id) ?? 0) < RECENT_SAVE_MS && local && local.content !== remote.content) {
    s.showToast({ message: `「${remote.title?.trim() || '无标题'}」刚在其他设备上被修改，正文已更新为最新版本` })
  }
  s.applyNote(remote)
  if (remote.deleted && s.activeNoteId === remote.id) {
    s.setActive(null)
    s.showToast({ message: `「${local?.title?.trim() || '无标题'}」已在其他设备上删除` })
  }
  return true
}

/**
 * 把一份云端内容存成冲突副本；短时间内的重复冲突更新同一条副本。
 *
 * 同一篇的归档必须串行。activeArchive 是在 createNote **返回之后**才写进去的，
 * 两次归档并发进来时，后一次读到的还是空，于是又建一条——用户会看到两条一模一样的
 * 「云端版本」副本和两条重复提示。串起来之后，后一次进来时前一次已经登记好了，
 * 会走下面那条复用分支去更新同一条副本。
 */
function archiveRemote(remote: Note, incoming?: string): Promise<boolean> {
  const epoch = getAccountEpoch()
  const prev = archiveChain.get(remote.id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => epoch === getAccountEpoch() ? doArchive(remote, incoming, epoch) : false)
  archiveChain.set(remote.id, next)
  void next.catch(() => {}).then(() => {
    if (archiveChain.get(remote.id) === next) archiveChain.delete(remote.id)
  })
  return next
}

/** 返回是否真的归档成功了——调用方要靠它决定敢不敢收下远端的版本号 */
async function doArchive(remote: Note, incoming: string | undefined, epoch: number): Promise<boolean> {
  const s = store()

  /*
   * 内容和本地一模一样就没必要建副本。
   *
   * 冲突副本是用来留住「不一样的那一版」的，一样的两版留下来只是噪音。
   * 最常见的来源是关窗：beforeunload 那次 flush 已经到了服务端，页面却已经卸载、
   * 没收到回执，重开后 restorePending 又补发一次，撞出一场自己跟自己的冲突。
   * 直接当归档成功放行，版本号照常对齐。
   */
  // 只比正文：副本存在的意义是留住不一样的那一版正文。标题在本地缓存里落盘有延迟
  // （persistCache 是防抖的），关窗那一下经常出现「正文一致、标题一个空一个有」，
  // 把标题算进来就会为此建一条毫无内容差异的副本
  // 已经被删掉的那一版不值得留副本——那等于把刚删掉的笔记原地复活一份，
  // 而且副本还是「未删除」状态，用户会以为删除没生效
  if (remote.deleted) return true

  /*
   * 比的是「本端马上要写上去的那份正文」，不是 store 里那份。
   *
   * store 的缓存是防抖落盘的，关窗重开这一下它往往还停在旧内容上，
   * 拿它去比就会得出「不一样」，白建一条和主笔记最终内容完全相同的副本。
   * 有 pending 就用 pending 里的，那才是本端的真实意图。
   */
  const mine = incoming ?? pendingSaves.get(remote.id)?.content ?? s.notes[remote.id]?.content
  if (mine !== undefined && mine === remote.content) return true
  const existing = activeArchive.get(remote.id)
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const title = `${remote.title || '无标题'}（云端版本 ${stamp}）`

  try {
    if (existing && Date.now() - existing.at < ARCHIVE_REUSE_MS && s.notes[existing.copyId]) {
      const copy = s.notes[existing.copyId]
      const updated = await api.updateNote(copy.id, {
        title,
        content: remote.content,
        excerpt: remote.excerpt,
        baseVersion: copy.version,
      })
      if (epoch !== getAccountEpoch()) return false
      s.applyNote(updated)
      activeArchive.set(remote.id, { copyId: updated.id, at: Date.now() })
      s.pushNotice({ noteId: remote.id, copyId: updated.id, copyTitle: title, at: Date.now() })
      return true
    }

    const copy = await api.createNote({
      folderId: remote.folderId,
      title,
      content: remote.content,
      excerpt: remote.excerpt,
      conflictOf: remote.id,
      sortOrder: Date.now(),
    })
    if (epoch !== getAccountEpoch()) return false
    s.applyNote(copy)
    activeArchive.set(remote.id, { copyId: copy.id, at: Date.now() })
    s.pushNotice({ noteId: remote.id, copyId: copy.id, copyTitle: title, at: Date.now() })
    return true
  } catch {
    // 归档失败不影响用户继续编辑，但**必须**告诉调用方：
    // 云端那一版没备份下来，谁都不许拿它的版本号去覆盖
    return false
  }
}

/** 增量拉取；断线重连、启动、切前台时调用 */
export async function pullDelta() {
  if (!session.token) return
  const epoch = getAccountEpoch()
  try {
    store().setStatus('syncing')
    const res = await api.pull(store().lastSeq)
    if (epoch !== getAccountEpoch()) return
    let complete = true
    for (const note of res.notes) if (!onRemoteNote(note)) complete = false
    store().applyBatch(res.folders, [], complete ? res.seq : undefined)
    if (!hasPending() && !loadQueue().length) store().setStatus('synced')
    else if (store().status === 'syncing') store().setStatus('error')
  } catch (err) {
    if (epoch !== getAccountEpoch()) return
    if (err instanceof AuthError) onAuthExpired(err.message)
    else store().setStatus(err instanceof OfflineError ? 'offline' : 'error')
  }
}

/* ---------------- 笔记保存 ---------------- */

/** 所有笔记字段使用同一份实时草稿、同一条提交队列。 */
export function queueSave(noteId: string, patch: Patch) {
  if (accountSuspended) return
  const local = store().notes[noteId]
  if (!local) return
  draftsLoaded = true
  if (!pendingBases.has(noteId)) pendingBases.set(noteId, local.version)
  pendingSaves.set(noteId, { ...pendingSaves.get(noteId), ...patch })
  store().applyNote({ ...local, ...patch, updatedAt: Date.now() })
  store().setDirty(noteId)
  saveFailures.delete(noteId)
  persistPending()
  const since = saveSince.get(noteId) ?? Date.now()
  saveSince.set(noteId, since)
  scheduleFlush(noteId, Math.min(SAVE_DEBOUNCE, Math.max(0, SAVE_MAX_WAIT - (Date.now() - since))))
}

function scheduleFlush(noteId: string, delay: number) {
  const prev = saveTimers.get(noteId)
  if (prev) clearTimeout(prev)
  const epoch = getAccountEpoch()
  saveTimers.set(noteId, setTimeout(() => {
    saveTimers.delete(noteId)
    if (epoch === getAccountEpoch() && !store().authExpired) void flushNote(noteId)
  }, delay))
}

/** 等待已有请求；请求成功后继续提交期间新增的草稿，失败则保留最新版本。 */
export function flushNote(noteId: string): Promise<void> {
  const existing = savingNotes.get(noteId)
  if (existing) return existing
  if (!pendingSaves.has(noteId) || !session.token || store().authExpired) return Promise.resolve()
  const epoch = getAccountEpoch()
  const task = Promise.resolve().then(() => saveDraft(noteId, epoch)).finally(() => {
    if (savingNotes.get(noteId) === task) savingNotes.delete(noteId)
  })
  savingNotes.set(noteId, task)
  return task
}

async function saveDraft(noteId: string, epoch: number) {
  if (loadQueue().some((op) => op.kind === 'note.create' && op.id === noteId)) {
    await replayQueue()
    if (epoch !== getAccountEpoch() || loadQueue().some((op) => op.kind === 'note.create' && op.id === noteId)) return
  }
  while (epoch === getAccountEpoch() && pendingSaves.has(noteId)) {
    const patch = pendingSaves.get(noteId)!
    const local = store().notes[noteId]
    if (!local) return // 保留可恢复草稿，不能因缓存缺失就删除。
    const timer = saveTimers.get(noteId)
    if (timer) clearTimeout(timer)
    saveTimers.delete(noteId)
    saveSince.delete(noteId)
    store().setStatus('syncing')
    try {
      let saved: Note
      try {
        saved = await api.updateNote(noteId, { ...patch, baseVersion: pendingBases.get(noteId) ?? local.version })
      } catch (err) {
        if (epoch !== getAccountEpoch()) return
        if (!(err instanceof ConflictError)) throw err
        // 仅改元信息时不覆盖远端正文，无需制造正文冲突副本。
        if (patch.content !== undefined && !(await archiveRemote(err.note, patch.content))) {
          throw new Error('云端有更新的版本，暂时没能备份下来')
        }
        if (epoch !== getAccountEpoch()) return
        saved = await api.updateNote(noteId, { ...patch, baseVersion: err.note.version })
      }
      if (epoch !== getAccountEpoch()) return
      const latest = pendingSaves.get(noteId)
      if (!latest) return // 已明确删除/丢弃的内容不被迟到回执复活。
      const unchanged = latest === patch
      if (unchanged) {
        pendingSaves.delete(noteId)
        pendingBases.delete(noteId)
      } else pendingBases.set(noteId, saved.version)
      store().applyNote({ ...saved, ...(unchanged ? {} : latest) })
      // 缓存先持久化，再清除磁盘上的已确认草稿。
      store().flushCache()
      persistPending()
      recentSave.set(noteId, Date.now())
      saveFailures.delete(noteId)
      store().markSaved()
      store().setDirty(pendingSaves.keys().next().value ?? null)
      store().setStatus(pendingSaves.size || loadQueue().length ? 'syncing' : 'synced')
    } catch (err) {
      if (epoch !== getAccountEpoch()) return
      // pending 始终是最新意图，失败回执绝不再写回捕获的旧 patch。
      persistPending()
      if (err instanceof AuthError) onAuthExpired(err.message)
      else if (err instanceof OfflineError) store().setStatus('offline')
      else {
        store().setStatus('error')
        const count = (saveFailures.get(noteId) ?? 0) + 1
        saveFailures.set(noteId, count)
        if (count < MAX_SAVE_RETRY) scheduleFlush(noteId, SAVE_DEBOUNCE * 2 * count)
        else store().showToast({ message: `「${local.title?.trim() || '无标题'}」暂时没能同步，草稿已保留，请稍后重试` })
      }
      return
    }
  }
}

function onAuthExpired(reason: string) {
  if (store().authExpired) return
  stop()
  store().setStatus('error')
  store().setAuthExpired(reason)
}

export async function flushAll() {
  const epoch = getAccountEpoch()
  for (const id of new Set([...pendingSaves.keys(), ...savingNotes.keys()])) {
    if (epoch !== getAccountEpoch()) return
    await flushNote(id)
  }
}

export const hasPending = (noteId?: string) => noteId === undefined
  ? pendingSaves.size > 0
  : pendingSaves.has(noteId)

function clearMemory() {
  pendingSaves.clear()
  draftsLoaded = false
  pendingReadBlocked = false
  backedUpCorruptPending = null
  pendingBases.clear()
  savingNotes.clear()
  saveFailures.clear()
  saveSince.clear()
  for (const timer of saveTimers.values()) clearTimeout(timer)
  saveTimers.clear()
  activeArchive.clear()
  archiveChain.clear()
  recentSave.clear()
  syncTask = null
  syncAgain = false
  replayTask = null
}

export function suspendAccount() {
  if (!accountSuspended) {
    const pendingSaved = persistPending()
    const cacheSaved = store().flushCache()
    if (!pendingSaved || !cacheSaved) throw new Error('本地草稿或缓存尚未安全写入，无法切换账号')
  }
  accountSuspended = true
  stop()
  invalidateAccountEpoch()
  clearMemory()
  store().setUser(null)
}

export function activateAccount(server: string, userId: string) {
  suspendAccount()
  activateAccountScope(server, userId)
  store().reloadCache()
  restorePending()
  accountSuspended = false
}

/** 明确丢弃当前账号的本地数据（测试及用户主动清理用）。 */
export function forgetLocalData() {
  stop()
  invalidateAccountEpoch()
  clearMemory()
  accountSuspended = false
  localStorage.removeItem(PENDING_KEY)
  localStorage.removeItem(QUEUE_KEY)
  store().reset()
}

/* ---------------- 结构性操作（乐观更新 + 离线入队） ---------------- */

export async function createFolder(name: string, parentId: string | null = null) {
  const epoch = getAccountEpoch()
  const id = newLocalId()
  const now = Date.now()
  const s = store()
  s.applyFolder({
    id, name, parentId, sortOrder: now, version: 1, seq: s.lastSeq,
    deleted: false, createdAt: now, updatedAt: now,
  })
  s.toggleExpand(parentId ?? '', true)
  try {
    const created = await api.createFolder({ id, name, parentId, sortOrder: now })
    if (epoch !== getAccountEpoch()) return id
    s.applyFolder(created)
  } catch (err) {
    if (epoch !== getAccountEpoch()) return id
    if (err instanceof OfflineError) enqueue({ kind: 'folder.create', id, name, parentId, sortOrder: now })
    else s.dropLocal('folder', id)
  }
  return id
}

export async function renameFolder(id: string, name: string) {
  const epoch = getAccountEpoch()
  const s = store()
  const cur = s.folders[id]
  if (!cur) return
  s.applyFolder({ ...cur, name })
  try {
    const updated = await api.updateFolder(id, { name })
    if (epoch !== getAccountEpoch()) return
    s.applyFolder(updated)
  } catch (err) {
    if (epoch !== getAccountEpoch()) return
    if (err instanceof OfflineError) enqueue({ kind: 'folder.update', id, name })
    else s.applyFolder(cur)
  }
}

/** 移动目录，可同时给一个新的排序值（同级拖拽排序用） */
export async function moveFolder(id: string, parentId: string | null, sortOrder?: number) {
  const epoch = getAccountEpoch()
  const s = store()
  const cur = s.folders[id]
  if (!cur) return
  if (cur.parentId === parentId && sortOrder === undefined) return
  const next = sortOrder ?? cur.sortOrder
  s.applyFolder({ ...cur, parentId, sortOrder: next })
  try {
    const updated = await api.updateFolder(id, { parentId, sortOrder: next })
    if (epoch !== getAccountEpoch()) return
    s.applyFolder(updated)
  } catch (err) {
    if (epoch !== getAccountEpoch()) return
    if (err instanceof OfflineError) enqueue({ kind: 'folder.update', id, parentId, sortOrder: next })
    else s.applyFolder(cur)
  }
}

export async function deleteFolder(id: string) {
  const epoch = getAccountEpoch()
  const s = store()
  const snapshot = s.folders[id]
  if (!snapshot) return
  try {
    const res = await api.deleteFolder(id)
    if (epoch !== getAccountEpoch()) return
    s.applyBatch(res.folders, res.notes)
    // 记下这次连带删掉的所有条目，撤销时一起恢复
    const removed = { folders: res.folders.map((f) => f.id), notes: res.notes.map((n) => n.id) }
    s.showToast({
      message: `已删除目录「${snapshot.name}」及其中 ${res.notes.length} 篇笔记`,
      actionLabel: '撤销',
      onAction: () => void restoreFolder(removed, epoch),
    })
  } catch (err) {
    if (epoch !== getAccountEpoch()) return
    if (err instanceof OfflineError) {
      s.applyFolder({ ...snapshot, deleted: true })
      enqueue({ kind: 'folder.delete', id })
    }
  }
}

/** 撤销目录删除：逐条把软删标记翻回去 */
async function restoreFolder(removed: { folders: string[]; notes: string[] }, epoch: number) {
  if (epoch !== getAccountEpoch()) return
  const s = store()
  for (const fid of removed.folders) {
    if (epoch !== getAccountEpoch()) return
    const f = s.folders[fid]
    if (!f) continue
    try {
      const updated = await api.updateFolder(fid, { name: f.name, parentId: f.parentId })
      if (epoch !== getAccountEpoch()) return
      s.applyFolder(updated)
      s.applyFolder({ ...store().folders[fid], deleted: false })
    } catch {
      if (epoch !== getAccountEpoch()) return
      /* 单条恢复失败不阻断其余条目 */
    }
  }
  for (const nid of removed.notes) {
    if (epoch !== getAccountEpoch()) return
    await restoreNote(nid)
  }
}

export async function createNote(folderId: string | null = null, seed?: { title?: string; content?: string }) {
  const epoch = getAccountEpoch()
  const id = newLocalId()
  const now = Date.now()
  const s = store()
  const draft: Note = {
    id, folderId,
    title: seed?.title ?? '',
    content: seed?.content ?? '',
    excerpt: '',
    sortOrder: now, version: 1, seq: s.lastSeq, deleted: false,
    conflictOf: null, tags: [], createdAt: now, updatedAt: now,
  }
  s.applyNote(draft)
  s.setActive(id)
  if (folderId) s.toggleExpand(folderId, true)

  store().flushCache()
  enqueue({ kind: 'note.create', id, folderId, title: draft.title, content: draft.content, excerpt: '', sortOrder: now })
  await replayQueue()
  if (epoch !== getAccountEpoch()) return id
  if (loadQueue().some((op) => op.kind === 'note.create' && op.id === id)) {
    s.showToast({ message: '新建的笔记暂时没能同步到云端，草稿已保留，稍后会自动重试' })
  }
  return id
}

/** 移动笔记，可同时给一个新的排序值（同级拖拽排序用） */
export async function moveNote(id: string, folderId: string | null, sortOrder?: number) {
  const cur = store().notes[id]
  if (!cur || (cur.folderId === folderId && sortOrder === undefined)) return
  queueSave(id, { folderId, sortOrder: sortOrder ?? cur.sortOrder })
  await flushNote(id)
}

export async function deleteNote(id: string) {
  const cur = store().notes[id]
  if (!cur) return
  const epoch = getAccountEpoch()
  queueSave(id, { deleted: true })
  if (store().activeNoteId === id) store().setActive(null)
  await flushNote(id)
  if (epoch !== getAccountEpoch()) return
  store().showToast({
    message: `已删除「${cur.title?.trim() || '无标题'}」`, actionLabel: '撤销',
    onAction: () => { void restoreNote(id); store().setActive(id) },
  })
}

/** 彻底删除，不可撤销 */
export async function purgeNote(id: string) {
  const epoch = getAccountEpoch()
  const s = store()
  try {
    await api.purgeNote(id)
    if (epoch !== getAccountEpoch()) return
    pendingSaves.delete(id)
    pendingBases.delete(id)
    persistPending()
    s.dropLocal('note', id)
  } catch (err) {
    if (epoch !== getAccountEpoch()) return
    if (err instanceof AuthError) onAuthExpired(err.message)
    else s.showToast({ message: err instanceof OfflineError ? '离线状态下无法彻底删除，联网后再试' : '彻底删除失败，笔记和草稿已保留，请稍后重试' })
  }
}

/** 从回收站恢复 */
export async function restoreNote(id: string) {
  const epoch = getAccountEpoch()
  if (!store().notes[id]) return
  queueSave(id, { deleted: false })
  await flushNote(id)
  if (epoch !== getAccountEpoch()) return
}

export async function setTags(id: string, tags: string[]) {
  if (!store().notes[id]) return
  queueSave(id, { tags })
  await flushNote(id)
}

export async function renameNote(id: string, title: string) {
  if (!store().notes[id]) return
  queueSave(id, { title })
  await flushNote(id)
}

/**
 * 关窗前想插一脚的（比如编辑器要结算标题）。
 *
 * 不能让它们各自去监听 beforeunload：这个模块是在 App 求值时就注册的，
 * 一定排在组件挂载后注册的监听器前面，等它们跑完，下面的 persistPending 快照和
 * flushAll 的待发列表早就取完了，那次结算等于白做——「关窗会结算标题」一直没生效。
 */
const beforeFlushHooks = new Set<() => void>()

export function onBeforeFlush(fn: () => void) {
  beforeFlushHooks.add(fn)
  return () => beforeFlushHooks.delete(fn)
}

/* 关窗前：先让钩子把话说完，再同步写进 localStorage（一定来得及），最后尽量发一次网络请求 */
window.addEventListener('beforeunload', () => {
  if (accountSuspended) return
  for (const fn of beforeFlushHooks) {
    try {
      fn()
    } catch {
      /* 一个钩子出错不能连累落库 */
    }
  }
  persistPending()
  void flushAll()
})

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (!accountSuspended && document.visibilityState === 'hidden') { persistPending(); store().flushCache() }
})
window.addEventListener('pagehide', () => { if (!accountSuspended) { persistPending(); store().flushCache() } })
