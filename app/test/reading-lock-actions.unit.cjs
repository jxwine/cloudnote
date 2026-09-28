// 执行真实阅读锁 actions 与锁链，传输和界面存储使用可控替身。
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const { transformSync } = require('../node_modules/esbuild')

const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const protection = revision => ({ salt: '00'.repeat(16), hash: '00'.repeat(32), iterations: 210000, revision })
const noteTarget = { kind: 'note', id: 'N' }
const folderTarget = { kind: 'folder', id: 'inner' }
const plain = value => JSON.parse(JSON.stringify(value))

function harness(options = {}) {
  const context = vm.createContext({ console })
  function load(name, imports = {}) {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/lib/' + name + '.ts'), 'utf8')
    const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
    const module = { exports: {} }
    vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(dep => {
      if (!(dep in imports)) throw new Error('Unexpected import: ' + dep)
      return imports[dep]
    }, module, module.exports)
    return module.exports
  }
  const events = [], calls = [], cached = []
  let epoch = 0, pending = false, queued = false
  let state = {
    folders: {
      outer: { id: 'outer', parentId: null, readingLock: protection('outer-r1') },
      inner: { id: 'inner', parentId: 'outer', readingLock: protection('inner-r1') },
    },
    notes: { N: { id: 'N', folderId: null, content: 'body', readingLock: protection('note-r1') } },
    lockEpoch: 0, lockGrants: {}, activeNoteId: 'N', activeFolderId: null,
    toggleExpand: (id, value) => events.push(['expand', id, value]),
    applyFolder: folder => {
      events.push(['applyFolder', folder.id])
      state = { ...state, folders: { ...state.folders, [folder.id]: folder } }
    },
    relock: target => {
      events.push(['relock', target])
      state = { ...state, lockEpoch: state.lockEpoch + 1, lockGrants: {} }
    },
    flushCache: () => {
      events.push(['cache'])
      cached.push(JSON.stringify({ notes: state.notes, folders: state.folders }))
    },
    showToast: toast => events.push(['toast', toast.message]),
  }
  const useStore = {
    getState: () => state,
    setState: patch => { state = { ...state, ...patch } },
  }
  const locks = load('readingLock')
  locks.onBeforeLock(() => events.push(['prepare']))
  const session = { token: 'test-token' }
  const api = {
    setReadingLock: async (target, body) => {
      events.push(['request'])
      calls.push({ target: plain(target), body: plain(body) })
      if (options.request) return options.request(target, body)
      const entity = target.kind === 'note' ? state.notes[target.id] : state.folders[target.id]
      return { ...entity, readingLock: body.password === null ? null : protection('new-revision') }
    },
  }
  const sync = {
    syncNow: async () => { events.push(['sync']); await options.sync?.() },
    hasPending: () => pending,
    hasQueuedOperations: () => queued,
    applyReadingLockNote: note => {
      events.push(['applyNote', note.id])
      state = { ...state, notes: { ...state.notes, [note.id]: note } }
    },
    queueSave: () => { throw new Error('密码不得进入草稿队列') },
    enqueue: () => { throw new Error('密码不得进入离线队列') },
  }
  const verifyCalls = []
  const actions = load('readingLockActions', {
    './api': { api, session }, './store': { useStore }, './sync': sync,
    './accountStorage': { getAccountEpoch: () => epoch },
    './readingLock': { ...locks, verifyReadingPassword: async (lock, password) => {
      verifyCalls.push({ lock, password })
      return options.verify ? options.verify(lock, password) : true
    } },
  })
  return {
    actions, events, calls, cached, locks, session, verifyCalls,
    state: () => state,
    setState: useStore.setState,
    setPending: value => { pending = value },
    setQueued: value => { queued = value },
    changeAccount: () => ++epoch,
    changeRevision: revision => useStore.setState({ notes: {
      ...state.notes, N: { ...state.notes.N, readingLock: protection(revision) },
    } }),
  }
}

const tests = []
const test = (name, run) => tests.push({ name, run })

for (const [name, interrupt] of [
  ['换账号', h => h.changeAccount()],
  ['切换页面', h => h.setState({ activeNoteId: 'other', lockEpoch: h.state().lockEpoch + 1 })],
  ['重新上锁', h => h.state().relock(noteTarget)],
  ['远端重设密码', h => h.changeRevision('remote-new')],
]) test(`异步密码校验期间${name}不得授予权限`, async () => {
  const gate = deferred()
  const h = harness({ verify: () => gate.promise })
  const unlocking = h.actions.unlockReadingLock(noteTarget, 'reading-password')
  const rejected = assert.rejects(unlocking, /页面或密码已发生变化/)
  interrupt(h)
  gate.resolve(true)
  await rejected
  assert.equal(Object.keys(h.state().lockGrants).length, 0)
  assert.equal(h.events.some(([event]) => event === 'expand'), false)
})

test('错误阅读密码不留下授权', async () => {
  const h = harness({ verify: async () => false })
  await assert.rejects(h.actions.unlockReadingLock(noteTarget, 'wrong'), /阅读密码不正确/)
  assert.equal(Object.keys(h.state().lockGrants).length, 0)
})

test('密码校验期间远端移动笔记离开原目录，不授予已离开范围的权限', async () => {
  const gate = deferred()
  const h = harness({ verify: () => gate.promise })
  h.setState({ notes: { N: { ...h.state().notes.N, folderId: 'outer' } } })
  const unlocking = h.actions.unlockReadingLock(noteTarget, 'outer-password')
  const rejected = assert.rejects(unlocking, /页面或密码已发生变化/)
  h.setState({ notes: { N: { ...h.state().notes.N, folderId: null } } })
  gate.resolve(true)
  await rejected
  assert.equal(h.state().lockGrants['folder:outer'], undefined)
  assert.equal(Object.keys(h.state().lockGrants).length, 0)
})

test('逐层解锁目录，在全部祖先和自身通过前不清空密码页', async () => {
  const h = harness()
  h.setState({ activeNoteId: null, activeFolderId: 'inner' })
  await h.actions.unlockReadingLock(folderTarget, 'outer-password')
  assert.equal(h.state().lockGrants['folder:outer'], 'outer-r1')
  assert.equal(h.state().lockGrants['folder:inner'], undefined)
  assert.equal(h.state().activeFolderId, 'inner')
  assert.equal(h.events.some(([event]) => event === 'expand'), false)
  await h.actions.unlockReadingLock(folderTarget, 'inner-password')
  assert.equal(h.state().lockGrants['folder:inner'], 'inner-r1')
  assert.equal(h.state().activeFolderId, null)
  assert.deepEqual(h.verifyCalls.map(call => call.lock.revision), ['outer-r1', 'inner-r1'])
  assert.deepEqual(h.events, [['expand', 'inner', true]])
})

test('密码变更先结算草稿并等待同步，成功后才应用与重锁', async () => {
  const gate = deferred()
  const h = harness({ sync: () => gate.promise })
  const changing = h.actions.changeReadingLock(noteTarget, 'new-reading-password', 'account-password')
  await tick()
  assert.deepEqual(h.events, [['prepare'], ['sync']])
  assert.equal(h.calls.length, 0)
  gate.resolve()
  await changing
  assert.deepEqual(h.events.map(event => event[0]), ['prepare', 'sync', 'request', 'prepare', 'applyNote', 'relock', 'cache', 'toast'])
  assert.deepEqual(h.calls[0], {
    target: noteTarget,
    body: { password: 'new-reading-password', accountPassword: 'account-password', baseLockRevision: 'note-r1' },
  })
  assert.equal(h.state().notes.N.readingLock.revision, 'new-revision')
  assert.ok(h.cached.every(cache => !cache.includes('new-reading-password') && !cache.includes('account-password')))
})

for (const [name, mark] of [
  ['正文待保存', h => h.setPending(true)],
  ['结构操作待发送', h => h.setQueued(true)],
]) test(`${name}时拒绝密码变更`, async () => {
  const h = harness()
  mark(h)
  await assert.rejects(h.actions.changeReadingLock(noteTarget, 'new-reading-password'), /还有改动未同步/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.state().notes.N.readingLock.revision, 'note-r1')
})

test('同步期间切换账号不发送密码请求', async () => {
  const gate = deferred()
  const h = harness({ sync: () => gate.promise })
  const changing = h.actions.changeReadingLock(noteTarget, 'new-reading-password')
  const rejected = assert.rejects(changing, /账号已切换/)
  h.changeAccount()
  gate.resolve()
  await rejected
  assert.equal(h.calls.length, 0)
})

test('同步期间远端改锁版本不发送过期密码请求', async () => {
  const gate = deferred()
  const h = harness({ sync: () => gate.promise })
  const changing = h.actions.changeReadingLock(noteTarget, 'new-reading-password')
  const rejected = assert.rejects(changing, /密码已在其他设备更新/)
  h.changeRevision('remote-new')
  gate.resolve()
  await rejected
  assert.equal(h.calls.length, 0)
})

test('密码请求在途切换账号后，旧回执不应用、不重锁、不写缓存', async () => {
  const gate = deferred()
  const h = harness({ request: () => gate.promise })
  const changing = h.actions.changeReadingLock(noteTarget, 'new-reading-password', 'account-password')
  await tick()
  assert.equal(h.calls.length, 1)
  h.changeAccount()
  h.setState({ notes: { N: { id: 'N', folderId: null, content: 'new account', readingLock: null } } })
  gate.resolve({ id: 'N', folderId: null, readingLock: protection('old-account-response') })
  await changing
  assert.equal(h.state().notes.N.content, 'new account')
  assert.equal(h.state().notes.N.readingLock, null)
  assert.equal(h.cached.length, 0)
  assert.deepEqual(h.events.map(event => event[0]), ['prepare', 'sync', 'request'])
})

test('离线密码变更失败保留原锁且不进入草稿或离线队列', async () => {
  const h = harness({ request: async () => { throw new Error('offline') } })
  await assert.rejects(h.actions.changeReadingLock(noteTarget, 'new-reading-password'), /offline/)
  assert.equal(h.state().notes.N.readingLock.revision, 'note-r1')
  assert.equal(h.cached.length, 0)
  assert.deepEqual(h.events.map(event => event[0]), ['prepare', 'sync', 'request'])
})

test('取消目录密码传递账号密码和 null，成功后更新目录', async () => {
  const h = harness()
  await h.actions.changeReadingLock(folderTarget, null, 'account-password')
  assert.deepEqual(h.calls[0].body, { password: null, accountPassword: 'account-password', baseLockRevision: 'inner-r1' })
  assert.equal(h.state().folders.inner.readingLock, null)
  assert.deepEqual(h.events.map(event => event[0]), ['prepare', 'sync', 'request', 'prepare', 'applyFolder', 'relock', 'cache', 'toast'])
})

test('首次设置密码使用 null 版本且无需账号密码', async () => {
  const h = harness()
  h.setState({ notes: { N: { ...h.state().notes.N, readingLock: null } } })
  await h.actions.changeReadingLock(noteTarget, 'new-reading-password')
  assert.deepEqual(h.calls[0].body, { password: 'new-reading-password', baseLockRevision: null })
})

test('未登录或密码格式无效时不触发同步和网络请求', async () => {
  const h = harness()
  h.session.token = null
  await assert.rejects(h.actions.changeReadingLock(noteTarget, 'new-reading-password'), /请先登录账号/)
  h.session.token = 'test-token'
  for (const password of ['short', 'x'.repeat(129)])
    await assert.rejects(h.actions.changeReadingLock(noteTarget, password), /6～128/)
  assert.equal(h.events.length, 0)
  assert.equal(h.calls.length, 0)
})

;(async () => {
  let failed = 0
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name) }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack) }
  }
  console.log(`reading-lock-actions.unit: ${tests.length - failed}/${tests.length} passed`)
  if (failed) process.exitCode = 1
})().catch(error => { console.error(error); process.exitCode = 1 })
