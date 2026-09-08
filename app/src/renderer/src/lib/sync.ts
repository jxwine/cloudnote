import { api, session, clientId, ConflictError, OfflineError, newLocalId } from './api'
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
  void pullDelta()
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
    s.applyNote(remote)
    return
  }

  // 版本对齐：本地内容不动，但接住云端的版本号，下次保存才不会再次冲突
  s.applyNote({ ...local, version: remote.version, seq: remote.seq })
  void archiveRemote(remote)
}

/** 把一份云端内容存成冲突副本；短时间内的重复冲突更新同一条副本 */
async function archiveRemote(remote: Note) {
  const s = store()
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
      return
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
  } catch {
    // 归档失败不能影响用户继续编辑，静默降级
  }
}

/** 增量拉取；断线重连、启动、切前台时调用 */
export async function pullDelta() {
  if (!session.token) return
  const s = store()
  try {
    s.setStatus('syncing')
    const res = await api.pull(s.lastSeq)
    s.applyBatch(res.folders, res.notes, res.seq)
    s.setStatus('synced')
  } catch (err) {
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
        // 云端有更新的版本：先把它归档，再用最新版本号把本地内容写上去
        await archiveRemote(err.note)
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
function retainPending(noteId: string, patch: Patch, reason?: string) {
  const times = (saveFailures.get(noteId) ?? 0) + 1
  if (times >= MAX_SAVE_RETRY) {
    saveFailures.delete(noteId)
    const title = store().notes[noteId]?.title?.trim() || '无标题'
    store().showToast({ message: `「${title}」保存失败${reason ? '：' + reason : ''}，改动未能同步` })
    persistPending()
    return
  }
  saveFailures.set(noteId, times)
  pendingSaves.set(noteId, patch)
  persistPending()
}

export async function flushAll() {
  for (const id of [...pendingSaves.keys()]) await flushNote(id)
}

export const hasPending = () => pendingSaves.size > 0

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

/* 关窗前：先同步写进 localStorage（一定来得及），再尽量发一次网络请求 */
window.addEventListener('beforeunload', () => {
  persistPending(true)
  void flushAll()
})
