// Deterministic synchronization regressions. Real sync/store modules, mocked transport.
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
const { transformSync } = require(path.join(root, 'app/node_modules/esbuild'))
const { create } = require(path.join(root, 'app/node_modules/zustand'))

const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const note = (id, content, version = 1, seq = 1, extra = {}) => ({
  id, folderId: null, title: id, content, excerpt: content, sortOrder: 1,
  version, seq, deleted: false, conflictOf: null, tags: [],
  createdAt: 1, updatedAt: seq, ...extra,
})

function harness(overrides = {}, storage = new Map()) {
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  }
  const timers = new Map()
  const sockets = []
  let nextTimer = 0
  class WebSocket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = WebSocket.CONNECTING
    constructor(url) { this.url = url; sockets.push(this) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  const context = vm.createContext({
    console, Date, localStorage,
    WebSocket,
    setTimeout: (callback, delay = 0) => {
      const id = ++nextTimer
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout: id => timers.delete(id),
    window: { addEventListener() {} },
  })
  const runTimers = async maxDelay => {
    for (let round = 0; round < 20; round++) {
      const ready = [...timers].filter(([, t]) => t.delay <= maxDelay)
      if (!ready.length) return
      for (const [id, t] of ready) {
        if (!timers.delete(id)) continue
        t.callback()
      }
      await tick()
    }
    throw new Error('Timer loop did not settle')
  }
  class OfflineError extends Error {}
  class AuthError extends Error {}
  class NotFoundError extends Error {}
  class ConflictError extends Error {
    constructor(remote) { super('conflict'); this.note = remote }
  }
  const api = {
    updateNote: async () => { throw new Error('Unexpected updateNote') },
    createNote: async () => { throw new Error('Unexpected createNote') },
    pull: async () => ({ seq: 0, folders: [], notes: [] }),
    ...overrides,
  }
  const deps = {
    api, session: { token: 'test', user: null, server: 'http://mock' }, clientId: 'test-client',
    OfflineError, AuthError, NotFoundError, ConflictError, newLocalId: () => 'local-id',
  }
  function load(file, imports) {
    const code = transformSync(fs.readFileSync(path.join(root, file), 'utf8'), {
      loader: 'ts', format: 'cjs', target: 'es2022',
    }).code
    const module = { exports: {} }
    vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(name => {
      if (!(name in imports)) throw new Error('Unexpected import: ' + name)
      return imports[name]
    }, module, module.exports)
    return module.exports
  }
  let epoch = 0
  const accountStorage = {
    activateAccountScope: () => ({ changed: false, epoch: 0 }),
    getAccountEpoch: () => epoch,
    invalidateAccountEpoch: () => ++epoch,
  }
  const readingLock = load('app/src/renderer/src/lib/readingLock.ts', {})
  const store = load('app/src/renderer/src/lib/store.ts', {
    zustand: { create }, './api': deps, './accountStorage': accountStorage,
    './readingLock': readingLock,
    './shortcuts': { SHORTCUTS: [], resolveBindings: () => [] },
    './viewport': { readViewport: () => 'desktop' },
  })
  const sync = load('app/src/renderer/src/lib/sync.ts', {
    './api': deps, './store': store, './accountStorage': accountStorage,
    './readingLock': readingLock,
  })
  const state = () => store.useStore.getState()
  const pending = id => {
    const raw = storage.get('cloudnote.pending')
    const entry = raw && JSON.parse(raw).find(row => row[0] === id)
    return entry?.[1]
  }
  return { api, sync, state, storage, localStorage, pending, runTimers, sockets, AuthError, OfflineError, NotFoundError, ConflictError, readingLock,
    bumpEpoch: () => ++epoch }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('missed permanent deletion is reconciled with the server and persisted across restart', async () => {
  const storage = new Map()
  let since
  const h = harness({ pull: async value => { since = value; return { seq: 5, folders: [], notes: [] } } }, storage)
  h.state().applyNote(note('N', 'trash', 2, 4, { deleted: true }))
  h.state().applyBatch([], [], 4)
  await h.sync.pullDelta()
  assert.equal(since, 0, 'cached trash requires a full snapshot because purges leave no delta')
  assert.equal(h.state().notes.N, undefined)
  assert.equal(h.state().lastSeq, 5)
  assert.equal(h.state().status, 'synced')
  const restarted = harness({}, storage)
  assert.equal(restarted.state().notes.N, undefined)
})

test('legacy trash reconciliation preserves offline new notes and changes newer than the snapshot', async () => {
  const storage = new Map([['cloudnote.cache', JSON.stringify({
    cursorVersion: 2, lastSeq: 5, folders: {}, notes: { N: note('N', 'legacy trash', 2, 4, { deleted: true }) },
  })]])
  let since
  const pull = deferred()
  const h = harness({ pull: value => { since = value; return pull.promise } }, storage)
  h.state().applyNote(note('new', 'offline new', 1, 5, { deleted: true }))
  h.localStorage.setItem('cloudnote.queue', JSON.stringify([{ kind: 'note.create', id: 'new' }]))
  const syncing = h.sync.pullDelta()
  h.state().applyNote(note('later', 'created after snapshot', 1, 7, { deleted: true }))
  pull.resolve({ seq: 6, folders: [], notes: [] })
  await syncing
  assert.equal(since, 0, 'cached trash must request an authoritative full snapshot')
  assert.equal(h.state().notes.N, undefined)
  assert.equal(h.state().notes.new.content, 'offline new')
  assert.equal(h.state().notes.later.content, 'created after snapshot')
})

test('permanent deletion removes pending drafts, queued operations and retry timers', async () => {
  let patches = 0
  const h = harness({
    updateNote: async () => { patches++; throw new Error('purged note must not be saved') },
    pull: async () => ({ seq: 3, folders: [], notes: [] }),
  })
  h.state().applyNote(note('N', 'trash', 1, 1, { deleted: true }))
  h.sync.queueSave('N', { title: 'pending title' })
  h.localStorage.setItem('cloudnote.queue', JSON.stringify([{ kind: 'note.delete', id: 'N' }]))
  await h.sync.pullDelta()
  assert.equal(h.sync.hasPending('N'), false)
  assert.equal(h.pending('N'), undefined)
  assert.equal(h.state().dirtyNoteId, null)
  assert.equal(h.sync.hasQueuedOperations(), false)
  await h.runTimers(5000)
  assert.equal(patches, 0)
  assert.equal(h.state().notes.N, undefined)
  assert.equal(h.state().status, 'synced')
})

test('late pull and websocket upsert cannot resurrect a permanently deleted note', async () => {
  const stale = deferred()
  let pulls = 0
  const h = harness({ pull: () => ++pulls === 1 ? stale.promise : Promise.resolve({ seq: 1, folders: [], notes: [] }) })
  h.state().applyNote(note('N', 'trash', 1, 1, { deleted: true }))
  h.sync.start()
  await tick()
  const socket = h.sockets[0]
  socket.onmessage({ data: JSON.stringify({ type: 'note:purged', id: 'N' }) })
  stale.resolve({ seq: 1, folders: [], notes: [note('N', 'stale trash', 1, 1, { deleted: true })] })
  await h.sync.syncNow()
  socket.onmessage({ data: JSON.stringify({ type: 'note:upsert', note: note('N', 'stale', 1, 1, { deleted: true }) }) })
  assert.equal(h.state().notes.N, undefined)
})

test('save response arriving after permanent deletion cannot restore the note or draft', async () => {
  const patch = deferred()
  const h = harness({
    updateNote: () => patch.promise,
    pull: async () => ({ seq: 3, folders: [], notes: [] }),
  })
  h.state().applyNote(note('N', 'trash', 1, 1, { deleted: true }))
  h.sync.queueSave('N', { title: 'edited title' })
  const saving = h.sync.flushNote('N')
  await tick()
  await h.sync.pullDelta()
  patch.resolve(note('N', 'old response', 2, 2, { deleted: true }))
  await saving
  assert.equal(h.state().notes.N, undefined)
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.pending('N'), undefined)
})

test('彻底删除后迟到的保存失败不能留下错误状态或重新安排重试', async () => {
  const patch = deferred()
  const h = harness({
    updateNote: () => patch.promise,
    pull: async () => ({ seq: 3, folders: [], notes: [] }),
  })
  h.state().applyNote(note('N', 'trash', 1, 1, { deleted: true }))
  h.sync.queueSave('N', { title: 'edited title' })
  const saving = h.sync.flushNote('N')
  await tick()
  await h.sync.pullDelta()
  patch.reject(new h.NotFoundError('already purged'))
  await saving
  assert.equal(h.state().notes.N, undefined)
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.pending('N'), undefined)
  assert.equal(h.state().status, 'synced')
  await h.runTimers(5000)
  assert.equal(h.state().status, 'synced')
  assert.equal(h.state().toast, null)
})

for (const reuse of [false, true]) {
  test(`彻底删除冲突副本后，迟到的${reuse ? '更新' : '创建'}归档回执不能复活副本或放行正文覆盖`, async () => {
    const archive = deferred()
    let server = note('N', 'remote first', 2, 2)
    let archiving = false
    const h = harness({
      updateNote: async (id, patch) => {
        if (id === 'copy') { archiving = true; return archive.promise }
        if (patch.baseVersion !== server.version) throw new h.ConflictError(server)
        server = note('N', patch.content, server.version + 1, server.seq + 1)
        return server
      },
      createNote: async input => {
        if (reuse) return note('copy', input.content, 1, 3, { conflictOf: 'N' })
        archiving = true
        return archive.promise
      },
    })
    h.sync.start()
    await h.sync.syncNow()
    h.state().applyNote(note('N', 'local', 1, 1))
    h.sync.queueSave('N', { content: 'local first' })
    if (reuse) {
      await h.sync.flushNote('N')
      assert.equal(h.state().notes.copy.content, 'remote first')
      server = note('N', 'remote second', server.version + 1, server.seq + 1)
      h.sync.queueSave('N', { content: 'local second' })
    }
    const saving = h.sync.flushNote('N')
    await tick()
    assert.equal(archiving, true)
    h.sockets[0].onmessage({ data: JSON.stringify({ type: 'note:purged', id: 'copy' }) })
    archive.resolve(note('copy', server.content, reuse ? 2 : 1, server.seq + 1, { conflictOf: 'N' }))
    await saving
    assert.equal(h.state().notes.copy, undefined)
    assert.equal(server.content, reuse ? 'remote second' : 'remote first')
    assert.equal(h.pending('N').content, reuse ? 'local second' : 'local first')
    h.sync.stop()
  })
}

test('新建请求仍在途时彻底删除必须等待创建确认，不能在云端留下幽灵笔记', async () => {
  const creation = deferred()
  let server = null
  let purges = 0
  const h = harness({
    createNote: async input => {
      await creation.promise
      server = note(input.id, input.content)
      return server
    },
    updateNote: async (id, patch) => {
      if (!server) throw new h.NotFoundError('already purged')
      server = note(id, server.content, 2, 2, { deleted: patch.deleted })
      return server
    },
    purgeNote: async () => {
      purges++
      if (!server) throw new h.NotFoundError('not created yet')
      server = null
    },
  })
  const creating = h.sync.createNote(null, { content: 'new note' })
  await tick()
  const deleting = h.sync.deleteNote('local-id')
  const purging = h.sync.purgeNote('local-id')
  await tick()
  assert.equal(purges, 0, '创建结果未确认前不能将 404 当作已彻底删除')
  creation.resolve()
  await Promise.all([creating, deleting, purging])
  assert.equal(purges, 1)
  assert.equal(server, null)
  assert.equal(h.state().notes['local-id'], undefined)
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.sync.hasQueuedOperations(), false)
})

test('彻底删除最后一份防抖待发草稿后必须结束同步中', async () => {
  const h = harness({
    updateNote: async (id, patch) => note(id, patch.content, 2, 2),
    purgeNote: async () => ({}),
  })
  for (const id of ['A', 'B']) {
    h.state().applyNote(note(id, 'old'))
    h.sync.queueSave(id, { content: 'draft' })
  }
  await h.sync.flushNote('A')
  assert.equal(h.state().status, 'syncing')
  await h.sync.purgeNote('B')
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.state().status, 'synced')
  await h.runTimers(5000)
  assert.equal(h.state().status, 'synced')
})

test('彻底删除后旧队列操作的迟到失败不能阻断后续新建', async () => {
  const deletion = deferred()
  const h = harness({
    deleteNote: () => deletion.promise,
    purgeNote: async () => ({}),
    createNote: async input => note(input.id, input.content),
  })
  h.state().applyNote(note('N', 'trash', 1, 1, { deleted: true }))
  h.storage.set('cloudnote.queue', JSON.stringify([{ kind: 'note.delete', id: 'N' }]))
  h.state().setStatus('syncing')
  const creating = h.sync.createNote(null, { content: 'keep creating' })
  await tick()
  await h.sync.purgeNote('N')
  deletion.reject(new h.NotFoundError('already purged'))
  await creating
  assert.equal(h.state().notes.N, undefined)
  assert.equal(h.state().notes['local-id'].content, 'keep creating')
  assert.equal(h.sync.hasQueuedOperations(), false)
  assert.equal(h.state().status, 'synced')
})

test('clearing an already purged note treats 404 as success and keeps unrelated drafts', async () => {
  const h = harness({ purgeNote: async () => { throw new h.NotFoundError('already gone') } })
  h.state().applyNote(note('N', 'stale trash', 1, 1, { deleted: true }))
  h.state().applyNote(note('other', 'other note'))
  h.sync.queueSave('N', { title: 'stale title' })
  h.sync.queueSave('other', { content: 'keep this draft' })
  await h.sync.purgeNote('N')
  assert.equal(h.state().notes.N, undefined)
  assert.equal(h.sync.hasPending('N'), false)
  assert.equal(h.pending('N'), undefined)
  assert.equal(h.pending('other').content, 'keep this draft')
  assert.equal(h.state().toast, null)
})

test('server failures preserve trash and drafts and failed full pulls never prune local data', async () => {
  const h = harness({
    purgeNote: async () => { throw new Error('server unavailable') },
    pull: async () => { throw new h.OfflineError() },
  })
  h.state().applyNote(note('N', 'trash', 1, 1, { deleted: true }))
  h.sync.queueSave('N', { title: 'keep title' })
  await h.sync.purgeNote('N')
  await h.sync.pullDelta()
  assert.equal(h.state().notes.N.title, 'keep title')
  assert.equal(h.pending('N').title, 'keep title')
  assert.ok(h.state().toast)
})

test('trash reconciliation preserves cloud trash and applies notes restored by another device', async () => {
  const h = harness({ pull: async () => ({ seq: 5, folders: [], notes: [
    note('N', 'still trash', 2, 3, { deleted: true }), note('restored', 'restored body', 3, 5),
  ] }) })
  h.state().applyNote(note('N', 'still trash', 2, 3, { deleted: true }))
  h.state().applyNote(note('restored', 'trash before restore', 2, 4, { deleted: true }))
  await h.sync.pullDelta()
  assert.equal(h.state().notes.N.deleted, true)
  assert.equal(h.state().notes.restored.deleted, false)
  assert.equal(h.state().notes.restored.content, 'restored body')
})

test('late deletion response from an old account cannot remove the current account note', async () => {
  const deletion = deferred()
  const h = harness({ purgeNote: () => deletion.promise })
  h.state().applyNote(note('N', 'old trash', 1, 1, { deleted: true }))
  const purging = h.sync.purgeNote('N')
  h.sync.suspendAccount()
  h.state().reset()
  h.state().applyNote(note('N', 'new account note'))
  deletion.reject(new h.NotFoundError('old account already purged'))
  await purging
  assert.equal(h.state().notes.N.content, 'new account note')
})

test('队列遇到登录失效后停止本轮同步，焦点重试也不能覆盖错误状态', async () => {
  let pulls = 0
  const h = harness({
    createNote: async () => { throw new h.AuthError('登录已失效') },
    pull: async () => { pulls++; throw new h.AuthError('登录已失效') },
  })
  h.storage.set('cloudnote.queue', JSON.stringify([
    { kind: 'note.create', id: 'N', folderId: null, title: 'N', content: 'draft', excerpt: '', sortOrder: 1 },
  ]))
  await h.sync.syncNow()
  await h.sync.syncNow()
  await h.sync.pullDelta()
  h.sync.start()
  await tick()
  assert.equal(h.state().authExpired, '登录已失效')
  assert.equal(h.state().status, 'error')
  assert.equal(pulls, 0, '鉴权失败后不得继续拉取或重新连接')
  assert.equal(h.sockets.length, 0)
  assert.equal(h.sync.hasQueuedOperations(), true)
})

test('另一篇失败草稿不能让已保存的当前笔记一直显示同步中', async () => {
  let online = false
  const h = harness({ updateNote: async (id, patch) => {
    if (id === 'A' && !online) throw new h.OfflineError()
    return note(id, patch.content, 2, 2)
  } })
  for (const id of ['A', 'B']) h.state().applyNote(note(id, 'old'))
  h.sync.queueSave('A', { content: 'A draft' })
  await h.sync.flushNote('A')
  h.sync.queueSave('B', { content: 'B saved' })
  await h.sync.flushNote('B')
  assert.equal(h.state().notes.B.content, 'B saved')
  assert.equal(h.pending('A').content, 'A draft')
  assert.equal(h.state().status, 'error', '没有正在发送或定时待发的请求时必须结束同步中')
  online = true
  await h.sync.syncNow()
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.state().status, 'synced')
})

test('遗留操作队列失败时，单篇保存成功仍应显示可重试的失败状态', async () => {
  const h = harness({
    createFolder: async () => { throw new h.OfflineError() },
    updateNote: async (id, patch) => note(id, patch.content, 2, 2),
  })
  h.storage.set('cloudnote.queue', JSON.stringify([{ kind: 'folder.create', id: 'F', name: 'F', parentId: null, sortOrder: 1 }]))
  await h.sync.syncNow()
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { content: 'saved' })
  await h.sync.flushNote('N')
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.sync.hasQueuedOperations(), true)
  assert.equal(h.state().status, 'error')
})

test('并发保存只有在所有请求完成后才结束同步中', async () => {
  const gate = deferred()
  const h = harness({ updateNote: async (id, patch) => id === 'A' ? gate.promise : note(id, patch.content, 2, 2) })
  for (const id of ['A', 'B']) {
    h.state().applyNote(note(id, 'old'))
    h.sync.queueSave(id, { content: 'saved' })
  }
  const first = h.sync.flushNote('A')
  await h.sync.flushNote('B')
  assert.equal(h.state().status, 'syncing')
  await h.sync.pullDelta()
  assert.equal(h.state().status, 'syncing', '拉取完成不能把仍在途的保存标成失败')
  gate.resolve(note('A', 'saved', 2, 2))
  await first
  assert.equal(h.state().status, 'synced')
})

test('WebSocket ready 不能把已失败的待发草稿重标为同步中', async () => {
  const h = harness({ updateNote: async () => { throw new h.OfflineError() } })
  h.sync.start()
  await h.sync.syncNow()
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { content: 'draft' })
  await h.sync.flushNote('N')
  h.sockets[0].onmessage({ data: JSON.stringify({ type: 'ready', peers: 2 }) })
  assert.equal(h.state().status, 'offline')
  assert.equal(h.state().peers, 2)
  assert.equal(h.pending('N').content, 'draft')
})

test('保存遇到登录失效时保留草稿，同号重新登录后自动补传并恢复已同步', async () => {
  let authorized = false
  let pulls = 0
  const h = harness({
    updateNote: async (id, patch) => {
      if (!authorized) throw new h.AuthError('登录已失效')
      return note(id, patch.content, 2, 2)
    },
    pull: async () => { pulls++; return { seq: 2, folders: [], notes: [] } },
  })
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { content: 'draft' })
  await h.sync.syncNow()
  await h.sync.syncNow()
  assert.equal(h.state().status, 'error')
  assert.equal(pulls, 0)
  assert.equal(h.pending('N').content, 'draft')
  h.sync.activateAccount('http://mock', 'same-user')
  authorized = true
  await h.sync.syncNow()
  assert.equal(h.state().authExpired, null)
  assert.equal(h.state().notes.N.content, 'draft')
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.state().status, 'synced')
})

test('并发拉取的迟到成功不能覆盖登录失效状态', async () => {
  const stale = deferred()
  let calls = 0
  const h = harness({ pull: async () => {
    if (++calls === 1) return stale.promise
    throw new h.AuthError('登录已失效')
  } })
  const first = h.sync.pullDelta()
  await h.sync.pullDelta()
  stale.resolve({ seq: 0, folders: [], notes: [] })
  await first
  assert.equal(h.state().authExpired, '登录已失效')
  assert.equal(h.state().status, 'error')
})

test('其他笔记仍在防抖等待时保持同步中，自动保存结束后显示已同步', async () => {
  const h = harness({ updateNote: async (id, patch) => note(id, patch.content, 2, 2) })
  for (const id of ['A', 'B']) {
    h.state().applyNote(note(id, 'old'))
    h.sync.queueSave(id, { content: 'saved' })
  }
  await h.sync.flushNote('A')
  assert.equal(h.state().status, 'syncing')
  await h.runTimers(700)
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.state().status, 'synced')
})

test('在途请求完成前，草稿保持持久化且标记待保存', async () => {
  const gate = deferred()
  const h = harness({ updateNote: () => gate.promise })
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { title: 'N', content: 'draft', excerpt: 'draft' })
  await h.runTimers(400)
  const flight = h.sync.flushNote('N')
  await tick()
  await h.runTimers(400)
  assert.equal(h.pending('N')?.content, 'draft')
  assert.equal(h.sync.hasPending(), true)
  gate.resolve(note('N', 'draft', 2, 2))
  await flight
  await h.runTimers(400)
  assert.equal(h.sync.hasPending(), false)
})

test('旧请求失败不能覆盖请求期间输入的新草稿', async () => {
  const gate = deferred()
  const h = harness({ updateNote: () => gate.promise })
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { title: 'N', content: 'first', excerpt: 'first' })
  const flight = h.sync.flushNote('N')
  await tick() // 让请求真正捕获 first 后再输入 second
  h.sync.queueSave('N', { title: 'N', content: 'second', excerpt: 'second' })
  gate.reject(new h.OfflineError())
  await flight
  await h.runTimers(400)
  assert.equal(h.pending('N')?.content, 'second')
  assert.equal(h.state().notes.N.content, 'second')
})

test('flushAll 等待同一笔记已在途的请求', async () => {
  const gate = deferred()
  const h = harness({ updateNote: () => gate.promise })
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { title: 'N', content: 'draft', excerpt: 'draft' })
  const flight = h.sync.flushNote('N')
  let flushed = false
  const all = h.sync.flushAll().then(() => { flushed = true })
  await tick()
  assert.equal(flushed, false)
  gate.resolve(note('N', 'draft', 2, 2))
  await Promise.all([flight, all])
  assert.equal(flushed, true)
})

test('网络恢复触发的第二轮对账不被仍在途的失败请求吞掉', async () => {
  const firstPatch = deferred()
  let attempts = 0
  let server = note('N', 'old')
  const h = harness({
    updateNote: async (_id, patch) => {
      if (++attempts === 1) return firstPatch.promise
      server = note('N', patch.content, 2, 2)
      return server
    },
    pull: async since => ({ seq: server.seq, folders: [], notes: server.seq > since ? [server] : [] }),
  })
  h.state().applyNote(server)
  h.sync.queueSave('N', { content: 'draft after reconnect' })
  const firstRound = h.sync.syncNow()
  await tick()
  assert.equal(attempts, 1)
  // 网络已恢复，但第一次请求的离线错误尚未返回。恢复事件再次请求对账。
  const recoveryRound = h.sync.syncNow()
  firstPatch.reject(new h.OfflineError())
  await Promise.all([firstRound, recoveryRound])
  assert.equal(attempts, 2)
  assert.equal(server.content, 'draft after reconnect')
  assert.equal(h.sync.hasPending(), false)
})

test('单条保存回执不能推进增量拉取游标', async () => {
  const remoteB = note('B', 'B remote', 2, 11)
  let pullSince
  const h = harness({
    updateNote: async (_id, patch) => note('A', patch.content, 2, 12),
    pull: async since => {
      pullSince = since
      return { seq: 12, folders: [], notes: remoteB.seq > since ? [remoteB] : [] }
    },
  })
  h.state().applyNote(note('A', 'A old', 1, 9))
  h.state().applyNote(note('B', 'B old', 1, 10))
  h.state().applyBatch([], [], 10)
  h.sync.queueSave('A', { title: 'A', content: 'A local', excerpt: 'A local' })
  await h.sync.syncNow()
  assert.equal(pullSince, 10)
  assert.equal(h.state().notes.B.content, 'B remote')
  assert.equal(h.state().lastSeq, 12)
})

test('归档失败时不覆盖远端正文，成功归档后才能写入本地正文', async () => {
  let server = note('N', 'B remote', 2, 11)
  const copies = []
  let archiveAttempts = 0
  const h = harness({
    updateNote: async (_id, patch) => {
      if (patch.baseVersion !== server.version) throw new h.ConflictError(server)
      server = note('N', patch.content, server.version + 1, server.seq + 1)
      return server
    },
    createNote: async input => {
      if (++archiveAttempts === 1) throw new Error('archive unavailable')
      const copy = note('copy', input.content, 1, 12, { title: input.title, conflictOf: 'N' })
      copies.push(copy)
      return copy
    },
  })
  h.state().applyNote(note('N', 'A local before save', 1, 10))
  h.sync.queueSave('N', { title: 'N', content: 'A local', excerpt: 'A local' })
  await h.sync.flushNote('N')
  assert.equal(server.content, 'B remote')
  assert.equal(copies.length, 0)
  assert.equal(h.sync.hasPending(), true)
  await h.sync.flushNote('N')
  assert.equal(server.content, 'A local')
  assert.equal(copies[0]?.content, 'B remote')
})

test('纯标题冲突只更新标题，不回退远端正文或创建副本', async () => {
  let server = note('N', '远端正文 Y', 2, 11)
  let copies = 0
  const sent = []
  const h = harness({
    updateNote: async (_id, patch) => {
      sent.push(patch)
      if (patch.baseVersion !== server.version) throw new h.ConflictError(server)
      server = { ...server, ...patch, version: server.version + 1, seq: server.seq + 1 }
      return server
    },
    createNote: async () => { copies++; throw new Error('纯标题编辑不应归档正文') },
  })
  h.state().applyNote(note('N', '本地旧正文 X', 1, 10))
  h.sync.queueSave('N', { title: '新标题' })
  await h.sync.flushNote('N')
  assert.equal(sent.length, 2, '先遇到 409，再用远端版本重试')
  assert.equal(sent[0].content, undefined)
  assert.equal(sent[1].content, undefined)
  assert.equal(server.content, '远端正文 Y')
  assert.equal(server.title, '新标题')
  assert.equal(h.state().notes.N.content, '远端正文 Y')
  assert.equal(copies, 0)
  assert.equal(h.sync.hasPending(), false)
})

test('并发拉取不能借用远端版本绕过归档失败', async () => {
  const firstPatch = deferred()
  let server = note('N', 'B remote', 2, 11)
  let patchCalls = 0
  const h = harness({
    updateNote: async (_id, patch) => {
      if (++patchCalls === 1) return firstPatch.promise
      if (patch.baseVersion !== server.version) throw new h.ConflictError(server)
      server = note('N', patch.content, server.version + 1, server.seq + 1)
      return server
    },
    createNote: async () => { throw new Error('archive unavailable') },
    pull: async since => ({
      seq: server.seq, folders: [], notes: server.seq > since ? [server] : [],
    }),
  })
  h.state().applyNote(note('N', 'A old', 1, 10))
  h.sync.queueSave('N', { title: 'N', content: 'A local', excerpt: 'A local' })
  const save = h.sync.flushNote('N')
  const reconcile = h.sync.syncNow()
  await tick()
  firstPatch.reject(new h.ConflictError(server))
  await Promise.all([save, reconcile])
  await h.sync.flushNote('N')
  assert.equal(server.content, 'B remote')
  assert.equal(h.sync.hasPending(), true)
})

test('账号切换后旧请求回执不能写入新账号状态', async () => {
  const gate = deferred()
  const h = harness({ updateNote: () => gate.promise })
  h.state().applyNote(note('old', 'old account', 1, 1))
  h.sync.queueSave('old', { content: 'old draft' })
  const flight = h.sync.flushNote('old')
  await tick()
  h.sync.suspendAccount()
  h.state().reset()
  h.state().applyNote(note('new', 'new account', 1, 1))
  gate.resolve(note('old', 'old draft', 2, 2))
  await flight
  assert.equal(h.state().notes.old, undefined)
  assert.equal(h.state().notes.new.content, 'new account')
})

test('正文请求在途时的元信息改动与正文一起提交', async () => {
  const gate = deferred()
  const sent = []
  const h = harness({
    updateNote: async (_id, patch) => {
      sent.push(patch)
      if (sent.length === 1) return gate.promise
      return note('N', patch.content, 3, 3, { title: patch.title })
    },
  })
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { title: 'N', content: 'new body', excerpt: 'new body' })
  const body = h.sync.flushNote('N')
  await tick()
  const title = h.sync.renameNote('N', 'new title')
  gate.resolve(note('N', 'new body', 2, 2))
  await Promise.all([body, title])
  assert.equal(sent.length, 2)
  assert.equal(sent[1].baseVersion, 2)
  assert.equal(sent[1].content, 'new body')
  assert.equal(sent[1].title, 'new title')
  assert.equal(h.state().notes.N.content, 'new body')
  assert.equal(h.state().notes.N.title, 'new title')
})

test('重启恢复草稿仍用写入时的基准版本检测冲突', async () => {
  const storage = new Map()
  const first = harness({}, storage)
  first.state().applyNote(note('N', 'local base', 1, 10))
  first.sync.queueSave('N', { content: 'A draft', title: 'N' })
  first.state().flushCache()
  // 模拟缓存已含更高版本，但持久化草稿仍以版本 1 为基准。
  const cache = JSON.parse(storage.get('cloudnote.cache'))
  cache.notes.N = note('N', 'B remote', 2, 11)
  storage.set('cloudnote.cache', JSON.stringify(cache))
  const server = note('N', 'B remote', 2, 11)
  const bases = []
  const copies = []
  const second = harness({
    updateNote: async (_id, patch) => {
      bases.push(patch.baseVersion)
      if (patch.baseVersion !== server.version) throw new second.ConflictError(server)
      return note('N', patch.content, 3, 13)
    },
    createNote: async input => {
      copies.push(input.content)
      return note('copy', input.content, 1, 12, { conflictOf: 'N' })
    },
    pull: async () => ({ seq: 13, folders: [], notes: [] }),
  }, storage)
  second.sync.start()
  await second.sync.syncNow()
  assert.deepEqual(bases, [1, 2])
  assert.deepEqual(copies, ['B remote'])
  assert.equal(second.state().notes.N.content, 'A draft')
})

test('新建笔记缓存缺失后仍可从待发草稿恢复并上传', async () => {
  const storage = new Map()
  const first = harness({ createNote: async () => { throw new Error('temporary failure') } }, storage)
  const id = await first.sync.createNote(null, { title: 'new note' })
  first.sync.queueSave(id, { title: 'new note', content: 'typed before restart', excerpt: 'typed' })
  const recovery = JSON.parse(storage.get('cloudnote.pending'))[0][2].note
  assert.equal(recovery.content, undefined, '已在 patch 中的正文不应在恢复快照里再存一份')
  storage.delete('cloudnote.cache')
  let server
  const second = harness({
    createNote: async input => {
      server = note(input.id, input.content, 1, 1, { title: input.title })
      return server
    },
    updateNote: async (_id, patch) => {
      server = note(id, patch.content, 2, 2, { title: patch.title })
      return server
    },
    pull: async () => ({ seq: server?.seq ?? 0, folders: [], notes: server ? [server] : [] }),
  }, storage)
  second.sync.start()
  await second.sync.syncNow()
  assert.equal(server?.content, 'typed before restart')
  assert.equal(second.state().notes[id]?.content, 'typed before restart')
  assert.equal(second.sync.hasPending(), false)
})

test('待发草稿写盘失败时禁止退出且保留内存内容', async () => {
  const h = harness()
  h.state().applyNote(note('N', 'old'))
  const setItem = h.localStorage.setItem
  h.localStorage.setItem = (key, value) => {
    if (key === 'cloudnote.pending') throw new Error('quota exceeded')
    setItem(key, value)
  }
  h.sync.queueSave('N', { content: 'new draft' })
  assert.throws(() => h.sync.suspendAccount(), /无法切换账号/)
  assert.equal(h.sync.hasPending('N'), true)
  assert.equal(h.state().notes.N.content, 'new draft')
  // 失败后仍可继续编辑，账号并未进入 suspended 状态。
  h.sync.queueSave('N', { content: 'newer draft' })
  assert.equal(h.state().notes.N.content, 'newer draft')
})

test('缓存写盘失败时禁止退出且保留待发草稿', async () => {
  const h = harness()
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { content: 'new draft' })
  const setItem = h.localStorage.setItem
  h.localStorage.setItem = (key, value) => {
    if (key === 'cloudnote.cache') throw new Error('quota exceeded')
    setItem(key, value)
  }
  assert.throws(() => h.sync.suspendAccount(), /无法切换账号/)
  assert.equal(h.sync.hasPending('N'), true)
  assert.equal(h.pending('N')?.content, 'new draft')
})

test('损坏草稿先备份再允许覆盖，备份失败则保留原文', async () => {
  const broken = '{original broken pending'
  const storage = new Map([['cloudnote.pending', broken]])
  const h = harness({}, storage)
  const setItem = h.localStorage.setItem
  h.localStorage.setItem = (key, value) => {
    if (key.startsWith('cloudnote.pending.corrupt.')) throw new Error('quota exceeded')
    setItem(key, value)
  }
  h.sync.start()
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { content: 'new draft' })
  assert.equal(storage.get('cloudnote.pending'), broken)
  assert.throws(() => h.sync.suspendAccount(), /无法切换账号/)
  assert.equal(h.state().notes.N.content, 'new draft')

  h.localStorage.setItem = setItem
  h.sync.start() // 现在备份可写，重新读取损坏原文
  h.sync.queueSave('N', { content: 'new draft' })
  assert.equal(h.pending('N')?.content, 'new draft')
  assert.ok([...storage].some(([key, value]) => key.startsWith('cloudnote.pending.corrupt.') && value === broken))
})

test('彻底删除请求离线失败时保留未上传草稿', async () => {
  const h = harness({ purgeNote: async () => { throw new h.OfflineError() } })
  h.state().applyNote(note('N', 'old'))
  h.sync.queueSave('N', { content: 'unsaved draft' })
  await h.sync.purgeNote('N')
  assert.equal(h.state().notes.N.content, 'unsaved draft')
  assert.equal(h.pending('N')?.content, 'unsaved draft')
  assert.equal(h.sync.hasPending(), true)
})

for (const [name, change, field, value] of [
  ['重命名', (sync) => sync.renameNote('N', 'renamed'), 'title', 'renamed'],
  ['标签', (sync) => sync.setTags('N', ['new']), 'tags', ['new']],
  ['移动', (sync) => sync.moveNote('N', 'folder'), 'folderId', 'folder'],
]) {
  test(`离线${name}在重连后补传`, async () => {
    let online = false
    let server = note('N', 'body')
    const sent = []
    const h = harness({
      updateNote: async (_id, patch) => {
        if (!online) throw new h.OfflineError()
        sent.push(patch)
        server = { ...server, ...patch, version: server.version + 1, seq: server.seq + 1 }
        return server
      },
      pull: async () => ({ seq: server.seq, folders: [], notes: [server] }),
    })
    h.state().applyNote(server)
    await change(h.sync)
    assert.deepEqual(h.state().notes.N[field], value)
    online = true
    await h.sync.syncNow()
    assert.deepEqual(server[field], value)
    assert.ok(sent.length > 0)
  })
}

const lock = (revision = 'lock-r1') => ({
  salt: '00'.repeat(16), hash: '00'.repeat(32), iterations: 210000, revision,
})
const folder = (id, parentId = null, readingLock = null, version = 1, seq = 1) => ({
  id, name: id, parentId, readingLock, version, seq, deleted: false,
  sortOrder: 1, createdAt: 1, updatedAt: seq,
})

test('远端将待保存笔记移入锁定目录时立即阻断查看且保留草稿', async () => {
  const h = harness({ pull: async () => ({
    seq: 3, folders: [], notes: [note('N', 'remote', 2, 3, { folderId: 'F' })],
  }) })
  h.state().applyFolder(folder('F', null, lock()))
  h.state().applyNote(note('N', 'original'))
  h.state().setActive('N')
  h.sync.queueSave('N', { content: 'draft' })
  await h.sync.pullDelta()
  assert.equal(h.state().notes.N.folderId, 'F')
  assert.equal(h.state().notes.N.content, 'draft')
  assert.equal(h.readingLock.canReadNote(h.state(), h.state().notes.N), false)
  assert.equal(h.pending('N').content, 'draft')
  assert.equal(h.state().notes.N.version, 1, '不能借用远端正文版本跳过冲突检查')
})

test('在途保存的迟到回执不得回滚新的锁与目录关系', async () => {
  const saved = deferred()
  const h = harness({
    updateNote: () => saved.promise,
    pull: async () => ({ seq: 5, folders: [], notes: [note('N', 'draft', 3, 5, { folderId: 'F', readingLock: lock() })] }),
  })
  h.state().applyFolder(folder('F', null, lock('folder-r1')))
  h.state().applyNote(note('N', 'original'))
  h.state().setActive('N')
  h.sync.queueSave('N', { content: 'draft' })
  const saving = h.sync.flushNote('N')
  await tick()
  await h.sync.pullDelta()
  saved.resolve(note('N', 'draft', 2, 4, { readingLock: null }))
  await saving
  assert.equal(h.state().notes.N.folderId, 'F')
  assert.equal(h.state().notes.N.readingLock.revision, 'lock-r1')
  assert.equal(h.state().notes.N.seq, 5)
  assert.equal(h.readingLock.canReadNote(h.state(), h.state().notes.N), false)
  assert.equal(h.sync.hasPending(), false)
})

test('远端将活动笔记移出目录后旧目录授权立即撤销', async () => {
  const h = harness()
  h.state().applyFolder(folder('F', null, lock()))
  h.state().applyNote(note('N', 'body', 1, 1, { folderId: 'F' }))
  h.state().setActive('N')
  h.state().lockGrants['folder:F'] = 'lock-r1'
  h.state().applyNote(note('N', 'body', 2, 3, { folderId: null }))
  assert.equal(h.state().lockGrants['folder:F'], undefined)
  h.state().openFolder('F')
  assert.equal(h.state().activeFolderId, 'F', '重新进入旧目录必须显示解锁页')
})

test('移动活动笔记的祖先目录也会撤销已离开范围的授权', async () => {
  const h = harness()
  h.state().applyFolder(folder('F', null, lock()))
  h.state().applyFolder(folder('C', 'F'))
  h.state().applyNote(note('N', 'body', 1, 1, { folderId: 'C' }))
  h.state().setActive('N')
  h.state().lockGrants['folder:F'] = 'lock-r1'
  h.state().applyFolder(folder('C', null, null, 2, 4))
  assert.equal(h.state().lockGrants['folder:F'], undefined)
  assert.equal(h.readingLock.canReadNote(h.state(), h.state().notes.N), true)
  h.state().openFolder('F')
  assert.equal(h.state().activeFolderId, 'F')
})

test('批量同步更新锁和目录时只保留当前范围有效授权', async () => {
  const h = harness()
  h.state().applyFolder(folder('F', null, lock()))
  h.state().applyFolder(folder('C', 'F', lock('child-r1')))
  h.state().applyNote(note('N', 'body', 1, 1, { folderId: 'C' }))
  h.state().setActive('N')
  h.state().lockGrants['folder:F'] = 'lock-r1'
  h.state().lockGrants['folder:C'] = 'child-r1'
  h.state().applyBatch([folder('C', null, lock('child-r2'), 2, 4)], [], 4)
  assert.equal(Object.keys(h.state().lockGrants).length, 0)
  assert.equal(h.readingLock.blockedLock(h.state(), { kind: 'note', id: 'N' }).id, 'C')
})

test('有未保存正文时远端重设独立密码立即撤销旧授权', async () => {
  const h = harness({ pull: async () => ({
    seq: 3, folders: [], notes: [note('N', 'remote', 2, 3, { readingLock: lock('new-revision') })],
  }) })
  h.state().applyNote(note('N', 'original', 1, 1, { readingLock: lock() }))
  h.state().setActive('N')
  h.state().lockGrants['note:N'] = 'lock-r1'
  h.sync.queueSave('N', { content: 'draft' })
  await h.sync.pullDelta()
  assert.equal(h.state().notes.N.readingLock.revision, 'new-revision')
  assert.equal(h.state().lockGrants['note:N'], undefined)
  assert.equal(h.state().notes.N.content, 'draft')
  assert.equal(h.readingLock.canReadNote(h.state(), h.state().notes.N), false)
  h.state().flushCache()
  const stored = JSON.parse(h.storage.get('cloudnote.cache'))
  assert.equal(stored.lockGrants, undefined, '授权不能持久化')
  assert.equal(stored.lockScope, undefined)
})

;(async () => {
  let failed = 0
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log('PASS ' + name)
    } catch (error) {
      failed++
      console.error('FAIL ' + name + ': ' + error.message)
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`)
  if (failed) process.exitCode = 1
})().catch(error => { console.error(error); process.exitCode = 1 })
