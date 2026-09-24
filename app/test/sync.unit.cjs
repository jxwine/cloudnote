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
  let nextTimer = 0
  class WebSocket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = WebSocket.CONNECTING
    constructor(url) { this.url = url }
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
    OfflineError, AuthError, ConflictError, newLocalId: () => 'local-id',
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
  const store = load('app/src/renderer/src/lib/store.ts', {
    zustand: { create }, './api': deps, './accountStorage': accountStorage,
    './shortcuts': { SHORTCUTS: [], resolveBindings: () => [] },
    './viewport': { readViewport: () => 'desktop' },
  })
  const sync = load('app/src/renderer/src/lib/sync.ts', {
    './api': deps, './store': store, './accountStorage': accountStorage,
  })
  const state = () => store.useStore.getState()
  const pending = id => {
    const raw = storage.get('cloudnote.pending')
    const entry = raw && JSON.parse(raw).find(row => row[0] === id)
    return entry?.[1]
  }
  return { api, sync, state, storage, localStorage, pending, runTimers, OfflineError, ConflictError,
    bumpEpoch: () => ++epoch }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

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
