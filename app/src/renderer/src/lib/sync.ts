import { api, session, clientId, AuthError, ConflictError, OfflineError, newLocalId } from './api'
import { useStore } from './store'
import type { Note } from './types'

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

type Patch = { title: string; content: string; excerpt: string }

/**
 * 每篇笔记待落库的改动。必须落到 localStorage：只放内存里的话，
 * 编辑后 700ms 内关掉应用（或离线时新建又编辑）内容就没了——
 * beforeunload 里的网络请求根本来不及发出去。
 */
const pendingSaves = new Map<string, Patch>()
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const saveFailures = new Map<string, number>()
/** 这一批待保存的改动最早是什么时候攒下的，用来兜住 SAVE_MAX_WAIT */
const saveSince = new Map<string, number>()
/** 正在发请求的笔记，防止同一篇并发两个 PATCH */
const savingNotes = new Set<string>()
/** 每次 queueSave 自增，用来判断请求期间有没有新改动进来 */
const saveGen = new Map<string, number>()
let persistTimer: ReturnType<typeof setTimeout> | null = null

function persistPending(immediate = false) {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  const write = () => {
    persistTimer = null
    try {
      if (pendingSaves.size) localStorage.setItem(PENDING_KEY, JSON.stringify([...pendingSaves]))
      else localStorage.removeItem(PENDING_KEY)
    } catch {
      /* 配额满了就放弃这份缓存，不影响在线保存 */
    }
  }
  if (immediate) write()
  else persistTimer = setTimeout(write, 200)
}

function restorePending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return
    for (const [id, patch] of JSON.parse(raw) as [string, Patch][]) {
      if (!pendingSaves.has(id)) pendingSaves.set(id, patch)
    }
  } catch {
    localStorage.removeItem(PENDING_KEY)
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

async function replayQueue() {
  const queue = loadQueue()
  if (!queue.length) return
  const rest: QueuedOp[] = []
  for (let i = 0; i < queue.length; i++) {
    const op = queue[i]
    try {
      await runOp(op)
    } catch (err) {
      if (err instanceof OfflineError) {
        // 还是离线，剩下的原样留到下次
        rest.push(...queue.slice(i))
        break
      }
      if (err instanceof AuthError) {
        // 凭证失效不是「这条操作有问题」，整队原样留着，别当业务错误丢掉
        rest.push(...queue.slice(i))
        onAuthExpired(err.message)
        break
      }
      // 业务错误（比如对象已被别端删除）直接丢弃，避免卡住整个队列
    }
  }
  saveQueue(rest)
}

async function runOp(op: QueuedOp) {
  switch (op.kind) {
    case 'folder.create':
      store().applyFolder(await api.createFolder(op))
      break
    case 'folder.update':
      store().applyFolder(await api.updateFolder(op.id, { name: op.name, parentId: op.parentId, sortOrder: op.sortOrder }))
      break
    case 'folder.delete': {
      const res = await api.deleteFolder(op.id)
      store().applyBatch(res.folders, res.notes)
      break
    }
    case 'note.create':
      store().applyNote(await api.createNote(op))
      break
    case 'note.delete':
      store().applyNote(await api.deleteNote(op.id))
      break
  }
}

/* ---------------- 连接与拉取 ---------------- */

export function start() {
  if (!session.token) return
  stopped = false
  // 上次没送出去的改动先捡回来，连上之后 flushAll 会补发
  restorePending()
  connectWs()
  void syncNow()
}

/**
 * 对账一次：**永远先把本地待发的送出去，再拉远端**。
 *
 * 顺序反过来会静默吃掉别的设备的改动：pullDelta 的 applyBatch 对「本地正在编辑」的笔记
 * 会把远端版本号收下（见 store.ts 里那段），随后 flushAll 拿着这个新版本号去 PATCH，
 * 服务端一比对 baseVersion 是最新的，判不出冲突就直接放行——乐观锁等于被自己解除了。
 * 断网续写、合盖再打开、切网络，都会走到这里。
 */
export async function syncNow() {
  await flushAll()
  await pullDelta()
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
  ws = new WebSocket(url)

  ws.onopen = () => {
    retry = 0
    store().setStatus('synced')
    void (async () => {
      await replayQueue()
      await flushAll()
      await pullDelta()
    })()
  }

  ws.onmessage = (ev) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(ev.data as string)
    } catch {
      return
    }
    handleMessage(msg)
  }

  ws.onclose = () => {
    ws = null
    if (stopped) return
    store().setStatus('offline', 0)
    scheduleReconnect()
  }

  ws.onerror = () => ws?.close()
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  const delay = Math.min(15_000, 800 * 2 ** retry++)
  reconnectTimer = setTimeout(connectWs, delay)
}

function handleMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'ready':
      store().setStatus('synced', (msg.peers as number) ?? 0)
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
function onRemoteNote(remote: Note) {
  const s = store()
  const local = s.notes[remote.id]
  const isEditing = s.dirtyNoteId === remote.id || pendingSaves.has(remote.id)

  // 别端把你正开着的这篇删了：合上它，别让编辑区停在一篇已经不存在的笔记上
  if (remote.deleted) {
    pendingSaves.delete(remote.id)
    persistPending()
    s.applyNote(remote)
    if (s.activeNoteId === remote.id) {
      s.setActive(null)
      s.showToast({ message: `「${local?.title?.trim() || '无标题'}」已在其他设备上删除` })
    }
    return
  }

  if (!isEditing || !local) {
    /*
     * 热更新：本地没有未落库的改动，直接用远端那一版盖上去。
     *
     * 但有一种情况不能一声不吭地盖：两台设备同时在改同一篇时，先保存成功的那台
     * 会在 markSaved 之后立刻失去 isEditing，紧接着就被后到的那一版热更新覆盖——
     * 用户眼睁睁看着自己刚敲的字消失，而冲突副本和提示都产生在**另一台**设备上，
     * 他这边什么都没有。归档由对方负责（重复归档只会多出一条副本），
     * 这里只补一句告知：至少让他知道字是被谁改没的，去哪儿找。
     */
    const justSaved = Date.now() - (recentSave.get(remote.id) ?? 0) < RECENT_SAVE_MS
    if (justSaved && local && local.content !== remote.content) {
      s.showToast({
        message: `「${remote.title?.trim() || '无标题'}」刚在其他设备上被修改，正文已更新为最新版本`,
      })
    }
    s.applyNote(remote)
    return
  }

  /*
   * 版本对齐：本地内容不动，但接住云端的版本号，下次保存才不会再次冲突。
   *
   * **必须等归档真的成功了再对齐。** 对齐是同步的、必然成功；归档是网络请求、可能失败
   * （比如网络刚恢复、服务端抖一下），而它原来失败是静默吞掉的。先对齐后归档的话，
   * 一旦归档失败，本地就拿着一个借来的新版本号——下次保存服务端一比对 baseVersion 是最新的，
   * 判不出冲突直接放行，云端那一版就被无声无息地覆盖了，两台设备都不会有任何提示。
   * 实测「断网续写 → 重连」丢的就是这一版。
   *
   * 归档没成功就把版本号留在旧值上：下次保存自然会撞 409，那条路会重新归档一次。
   */
  void archiveRemote(remote).then((archived) => {
    const cur = store().notes[remote.id]
    if (!cur) return
    if (archived) store().applyNote({ ...cur, version: remote.version, seq: remote.seq })
    else store().setStatus('error')
  })
}

/**
 * 把一份云端内容存成冲突副本；短时间内的重复冲突更新同一条副本。
 *
 * 同一篇的归档必须串行。activeArchive 是在 createNote **返回之后**才写进去的，
 * 两次归档并发进来时，后一次读到的还是空，于是又建一条——用户会看到两条一模一样的
 * 「云端版本」副本和两条重复提示。串起来之后，后一次进来时前一次已经登记好了，
 * 会走下面那条复用分支去更新同一条副本。
 */
function archiveRemote(remote: Note): Promise<boolean> {
  const prev = archiveChain.get(remote.id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => doArchive(remote))
  archiveChain.set(remote.id, next)
  void next.catch(() => {}).then(() => {
    if (archiveChain.get(remote.id) === next) archiveChain.delete(remote.id)
  })
  return next
}

/** 返回是否真的归档成功了——调用方要靠它决定敢不敢收下远端的版本号 */
async function doArchive(remote: Note): Promise<boolean> {
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
  const mine = s.notes[remote.id]
  if (mine && mine.content === remote.content) return true
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
  const s = store()
  try {
    s.setStatus('syncing')
    const res = await api.pull(s.lastSeq)

    /*
     * 本地还攒着改动的笔记不能走批量覆盖那条路。
     *
     * applyBatch 遇到这种笔记只会「留下本地内容、收下远端版本号」，既不保留远端那一版，
     * 也不给用户任何提示——远端内容就这么没了。交给 onRemoteNote 单独走一遍，
     * 它会把云端那一版归档成冲突副本并弹提示，和 WebSocket 推送的处理保持一致。
     *
     * 判断用 pendingSaves 而不是 dirtyNoteId：后者是全局单值，任何一篇保存成功
     * 都会把它清掉（markSaved），拿它当「这篇有没有未落库的改动」并不可靠。
     */
    const held = res.notes.filter((n) => pendingSaves.has(n.id) && !n.deleted)
    const plain = held.length ? res.notes.filter((n) => !pendingSaves.has(n.id) || n.deleted) : res.notes

    s.applyBatch(res.folders, plain, res.seq)
    for (const n of held) onRemoteNote(n)
    s.setStatus('synced')
  } catch (err) {
    if (err instanceof AuthError) {
      onAuthExpired(err.message)
      return
    }
    s.setStatus(err instanceof OfflineError ? 'offline' : 'error')
  }
}

/* ---------------- 笔记保存 ---------------- */

/** 编辑器每次变更调用；内部做防抖，真正落库在 flushNote */
export function queueSave(noteId: string, patch: Patch) {
  pendingSaves.set(noteId, patch)
  persistPending()
  store().setDirty(noteId)
  saveGen.set(noteId, (saveGen.get(noteId) ?? 0) + 1)

  const since = saveSince.get(noteId) ?? Date.now()
  saveSince.set(noteId, since)

  // 防抖的规则是「停手 700ms 才发」。可要是一直不停手，定时器就一直往后顺延，
  // 一篇长文能写十分钟一次都没存过。所以攒够 SAVE_MAX_WAIT 就不再顺延，立刻落一次。
  scheduleFlush(noteId, Date.now() - since >= SAVE_MAX_WAIT ? 0 : SAVE_DEBOUNCE)
}

function scheduleFlush(noteId: string, delay: number) {
  const prev = saveTimers.get(noteId)
  if (prev) clearTimeout(prev)
  saveTimers.set(
    noteId,
    setTimeout(() => {
      saveTimers.delete(noteId)
      void flushNote(noteId)
    }, delay)
  )
}

/**
 * 写回保存结果。请求飞行期间用户可能又敲了几个字，这时只接受服务端的版本号，
 * 正文仍以本地为准，否则会把刚输入的内容回退掉。
 */
function commitSaved(noteId: string, saved: Note) {
  const s = store()
  recentSave.set(noteId, Date.now())
  const stillEditing = pendingSaves.has(noteId)
  const local = s.notes[noteId]
  if (stillEditing && local) {
    s.applyNote({ ...local, version: saved.version, seq: saved.seq, updatedAt: saved.updatedAt })
    return
  }
  s.applyNote(saved)
  s.markSaved()
}

/** 立即落库（切换笔记、关闭窗口、Ctrl+S 时调用） */
export async function flushNote(noteId: string) {
  if (savingNotes.has(noteId)) {
    // 上一次保存还在路上。这会儿再发一个请求，带的还是同一个 baseVersion，
    // 服务端只会判 409 —— 等于自己跟自己冲突，白白多出一条冲突副本。
    // 内容留在 pendingSaves 里，那次请求回来后会自动补发。
    return
  }
  const patch = pendingSaves.get(noteId)
  if (!patch) return
  pendingSaves.delete(noteId)
  saveSince.delete(noteId)
  persistPending()
  const timer = saveTimers.get(noteId)
  if (timer) {
    clearTimeout(timer)
    saveTimers.delete(noteId)
  }

  const s = store()
  const local = s.notes[noteId]
  if (!local) {
    // 笔记在本地已经不存在了（比如被别端删掉），这份改动没有归属，丢掉
    saveFailures.delete(noteId)
    return
  }

  // 记下当前世代：请求期间用户要是又敲了字，回来得补发一次
  const gen = saveGen.get(noteId) ?? 0
  savingNotes.add(noteId)
  try {
    s.setStatus('syncing')
    try {
      const saved = await api.updateNote(noteId, { ...patch, baseVersion: local.version })
      commitSaved(noteId, saved)
      saveFailures.delete(noteId)
      s.setStatus('synced')
    } catch (err) {
      if (err instanceof ConflictError) {
        // 云端有更新的版本：先把它归档，再用最新版本号把本地内容写上去。
        // 归档没成功就绝不能往下走——那一步会拿云端的版本号把云端内容盖掉，
        // 而这时它还没有任何备份，等于把别的设备刚写的东西直接删了
        if (!(await archiveRemote(err.note))) {
          retainPending(noteId, patch, '云端有更新的版本，暂时没能备份下来')
          s.setStatus('error')
          return
        }
        try {
          const saved = await api.updateNote(noteId, { ...patch, baseVersion: err.note.version })
          commitSaved(noteId, saved)
          s.setStatus('synced')
        } catch {
          retainPending(noteId, patch)
          s.setStatus('error')
        }
        return
      }
      if (err instanceof OfflineError) {
        // 内容留着，重连时 flushAll 会补发
        pendingSaves.set(noteId, patch)
        persistPending()
        s.applyNote({ ...local, ...patch, updatedAt: Date.now() })
        s.setStatus('offline')
        return
      }
      if (err instanceof AuthError) {
        // 重试一万次也是同样的结果，还会把重试次数耗光。内容留住，停下来等用户重新登录
        pendingSaves.set(noteId, patch)
        persistPending()
        s.applyNote({ ...local, ...patch, updatedAt: Date.now() })
        onAuthExpired(err.message)
        return
      }
      retainPending(noteId, patch, err instanceof Error ? err.message : undefined)
      s.setStatus('error')
    }

    saveFailures.delete(noteId)
  } finally {
    savingNotes.delete(noteId)
    if ((saveGen.get(noteId) ?? 0) !== gen && pendingSaves.has(noteId)) {
      scheduleFlush(noteId, SAVE_DEBOUNCE)
    }
  }
}

/**
 * 保存失败后把内容留住等下次重试。但业务错误重试多半也没用，
 * 连续失败几次就放弃并告诉用户，否则它会一直卡在待保存队列里反复撞墙。
 */
/**
 * 保存失败了，把内容留住等下次。
 *
 * **不管失败多少次，内容都必须放回去。** flushNote 一开始就把这份 patch 从
 * pendingSaves 和 localStorage 里摘走了，这里是它唯一的落脚点——原来的写法在
 * 重试次数用尽时既不放回队列、也不写回 store，还顺手 persistPending() 把盘上
 * 那份也抹了，于是用户切个笔记（setContent 用 store 里的旧内容重置编辑器）
 * 刚写的东西就永久没了，而他看到的只是一句「未能同步」，还以为过会儿会自己重发。
 *
 * 「放弃」放弃的是**自动重试**，不是内容。
 */
function retainPending(noteId: string, patch: Patch, reason?: string) {
  pendingSaves.set(noteId, patch)
  const local = store().notes[noteId]
  if (local) store().applyNote({ ...local, ...patch, updatedAt: Date.now() })
  persistPending()

  const times = (saveFailures.get(noteId) ?? 0) + 1
  if (times >= MAX_SAVE_RETRY) {
    // 计数归零：不再自动撞墙，但用户下次敲字、切笔记或重连时还会再试一次
    saveFailures.delete(noteId)
    const title = local?.title?.trim() || '无标题'
    store().showToast({
      message: `「${title}」暂时没能同步${reason ? '：' + reason : ''}。改动已存在本机，联网后会自动补上`,
    })
    return
  }
  saveFailures.set(noteId, times)
}

/**
 * 凭证不作数了。
 *
 * 停掉同步别再撞墙，把待发内容原样留着，然后让界面去提示用户重新登录。
 * 这里**不碰** pendingSaves、不碰缓存——用户手上可能正有没传上去的东西。
 */
function onAuthExpired(reason: string) {
  if (store().authExpired) return
  stop()
  store().setStatus('error')
  store().setAuthExpired(reason)
}

export async function flushAll() {
  for (const id of [...pendingSaves.keys()]) await flushNote(id)
}

export const hasPending = () => pendingSaves.size > 0

/**
 * 把本机攒下的东西全部丢掉：待发的改动、离线操作队列、笔记缓存。
 *
 * **只在换账号登录时调用。** 凭证失效那条路特意保住了这些东西，
 * 为的是同一个账号登回来能把改动补传上去；但换了个人登进来，
 * 这些既传不上去也不该给他看。
 */
export function forgetLocalData() {
  pendingSaves.clear()
  saveFailures.clear()
  saveSince.clear()
  saveGen.clear()
  for (const t of saveTimers.values()) clearTimeout(t)
  saveTimers.clear()
  activeArchive.clear()
  archiveChain.clear()
  recentSave.clear()
  localStorage.removeItem(PENDING_KEY)
  localStorage.removeItem(QUEUE_KEY)
  store().reset()
}

/* ---------------- 结构性操作（乐观更新 + 离线入队） ---------------- */

export async function createFolder(name: string, parentId: string | null = null) {
  const id = newLocalId()
  const now = Date.now()
  const s = store()
  s.applyFolder({
    id, name, parentId, sortOrder: now, version: 1, seq: s.lastSeq,
    deleted: false, createdAt: now, updatedAt: now,
  })
  s.toggleExpand(parentId ?? '', true)
  try {
    s.applyFolder(await api.createFolder({ id, name, parentId, sortOrder: now }))
  } catch (err) {
    if (err instanceof OfflineError) enqueue({ kind: 'folder.create', id, name, parentId, sortOrder: now })
    else s.dropLocal('folder', id)
  }
  return id
}

export async function renameFolder(id: string, name: string) {
  const s = store()
  const cur = s.folders[id]
  if (!cur) return
  s.applyFolder({ ...cur, name })
  try {
    s.applyFolder(await api.updateFolder(id, { name }))
  } catch (err) {
    if (err instanceof OfflineError) enqueue({ kind: 'folder.update', id, name })
    else s.applyFolder(cur)
  }
}

/** 移动目录，可同时给一个新的排序值（同级拖拽排序用） */
export async function moveFolder(id: string, parentId: string | null, sortOrder?: number) {
  const s = store()
  const cur = s.folders[id]
  if (!cur) return
  if (cur.parentId === parentId && sortOrder === undefined) return
  const next = sortOrder ?? cur.sortOrder
  s.applyFolder({ ...cur, parentId, sortOrder: next })
  try {
    s.applyFolder(await api.updateFolder(id, { parentId, sortOrder: next }))
  } catch (err) {
    if (err instanceof OfflineError) enqueue({ kind: 'folder.update', id, parentId, sortOrder: next })
    else s.applyFolder(cur)
  }
}

export async function deleteFolder(id: string) {
  const s = store()
  const snapshot = s.folders[id]
  if (!snapshot) return
  try {
    const res = await api.deleteFolder(id)
    s.applyBatch(res.folders, res.notes)
    // 记下这次连带删掉的所有条目，撤销时一起恢复
    const removed = { folders: res.folders.map((f) => f.id), notes: res.notes.map((n) => n.id) }
    s.showToast({
      message: `已删除目录「${snapshot.name}」及其中 ${res.notes.length} 篇笔记`,
      actionLabel: '撤销',
      onAction: () => void restoreFolder(removed),
    })
  } catch (err) {
    if (err instanceof OfflineError) {
      s.applyFolder({ ...snapshot, deleted: true })
      enqueue({ kind: 'folder.delete', id })
    }
  }
}

/** 撤销目录删除：逐条把软删标记翻回去 */
async function restoreFolder(removed: { folders: string[]; notes: string[] }) {
  const s = store()
  for (const fid of removed.folders) {
    const f = s.folders[fid]
    if (!f) continue
    try {
      s.applyFolder(await api.updateFolder(fid, { name: f.name, parentId: f.parentId }))
      s.applyFolder({ ...store().folders[fid], deleted: false })
    } catch {
      /* 单条恢复失败不阻断其余条目 */
    }
  }
  for (const nid of removed.notes) await restoreNote(nid)
}

export async function createNote(folderId: string | null = null, seed?: { title?: string; content?: string }) {
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

  try {
    s.applyNote(await api.createNote({ id, folderId, title: draft.title, content: draft.content, sortOrder: now }))
  } catch (err) {
    if (err instanceof OfflineError)
      enqueue({ kind: 'note.create', id, folderId, title: draft.title, content: draft.content, excerpt: '', sortOrder: now })
    else s.dropLocal('note', id)
  }
  return id
}

/** 移动笔记，可同时给一个新的排序值（同级拖拽排序用） */
export async function moveNote(id: string, folderId: string | null, sortOrder?: number) {
  const s = store()
  const cur = s.notes[id]
  if (!cur) return
  if (cur.folderId === folderId && sortOrder === undefined) return
  const next = sortOrder ?? cur.sortOrder
  s.applyNote({ ...cur, folderId, sortOrder: next })
  const patch = { folderId, sortOrder: next }
  try {
    s.applyNote(await api.updateNote(id, { ...patch, baseVersion: cur.version }))
  } catch (err) {
    if (err instanceof ConflictError) {
      // 移动不涉及正文，直接基于云端最新版本重试
      try {
        s.applyNote(await api.updateNote(id, { ...patch, baseVersion: err.note.version }))
      } catch {
        s.applyNote(cur)
      }
    } else if (!(err instanceof OfflineError)) {
      s.applyNote(cur)
    }
  }
}

export async function deleteNote(id: string) {
  const s = store()
  const cur = s.notes[id]
  if (!cur) return
  pendingSaves.delete(id)
  persistPending()
  s.applyNote({ ...cur, deleted: true })
  if (s.activeNoteId === id) s.setActive(null)
  try {
    s.applyNote(await api.deleteNote(id))
  } catch (err) {
    if (err instanceof OfflineError) enqueue({ kind: 'note.delete', id })
    else {
      s.applyNote(cur)
      return
    }
  }
  // 删除是软删除，给一个撤销的机会，避免误点就找不回来
  s.showToast({
    message: `已删除「${cur.title?.trim() || '无标题'}」`,
    actionLabel: '撤销',
    onAction: () => {
      void restoreNote(id)
      store().setActive(id)
    },
  })
}

/** 彻底删除，不可撤销 */
export async function purgeNote(id: string) {
  const s = store()
  pendingSaves.delete(id)
  persistPending()
  try {
    await api.purgeNote(id)
    s.dropLocal('note', id)
  } catch (err) {
    if (!(err instanceof OfflineError)) s.dropLocal('note', id)
    else s.showToast({ message: '离线状态下无法彻底删除，联网后再试' })
  }
}

/** 从回收站恢复 */
export async function restoreNote(id: string) {
  const s = store()
  const cur = s.notes[id]
  if (!cur) return
  s.applyNote({ ...cur, deleted: false })
  try {
    s.applyNote(await api.updateNote(id, { deleted: false, baseVersion: cur.version }))
  } catch (err) {
    if (err instanceof ConflictError) {
      try {
        s.applyNote(await api.updateNote(id, { deleted: false, baseVersion: err.note.version }))
      } catch {
        s.applyNote(cur)
      }
    } else if (!(err instanceof OfflineError)) {
      s.applyNote(cur)
    }
  }
}

/** 改标签 */
export async function setTags(id: string, tags: string[]) {
  const s = store()
  const cur = s.notes[id]
  if (!cur) return
  s.applyNote({ ...cur, tags })
  try {
    s.applyNote(await api.updateNote(id, { tags, baseVersion: cur.version }))
  } catch (err) {
    if (err instanceof ConflictError) {
      try {
        s.applyNote(await api.updateNote(id, { tags, baseVersion: err.note.version }))
      } catch {
        s.applyNote(cur)
      }
    } else if (!(err instanceof OfflineError)) {
      s.applyNote(cur)
    }
  }
}

export async function renameNote(id: string, title: string) {
  const s = store()
  const cur = s.notes[id]
  if (!cur) return
  s.applyNote({ ...cur, title })
  try {
    s.applyNote(await api.updateNote(id, { title, baseVersion: cur.version }))
  } catch (err) {
    if (err instanceof ConflictError) {
      try {
        s.applyNote(await api.updateNote(id, { title, baseVersion: err.note.version }))
      } catch {
        s.applyNote(cur)
      }
    }
  }
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
  for (const fn of beforeFlushHooks) {
    try {
      fn()
    } catch {
      /* 一个钩子出错不能连累落库 */
    }
  }
  persistPending(true)
  void flushAll()
})
