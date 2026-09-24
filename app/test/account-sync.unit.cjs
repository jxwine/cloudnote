// 跨模块账号切换回归：真实 api/accountStorage/store/sync，网络和浏览器环境由本文件模拟。
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const { transformSync } = require('../node_modules/esbuild')
const { create } = require('../node_modules/zustand')

const A = { id: 'account-A', email: 'a@example.com' }
const B = { id: 'account-B', email: 'b@example.com' }
const server = 'https://notes.example'
const cacheKey = 'cloudnote.cache'
const pendingKey = 'cloudnote.pending'
const queueKey = 'cloudnote.queue'
const note = (id, content) => ({
  id, folderId: null, title: id, content, excerpt: content, sortOrder: 1,
  version: 1, seq: 1, deleted: false, conflictOf: null, tags: [],
  createdAt: 1, updatedAt: 1,
})

function harness(storage = new Map()) {
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  }
  const timers = new Map()
  let timerId = 0
  const context = vm.createContext({
    console, Date, Math, localStorage,
    window: { addEventListener() {} },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout: id => timers.delete(id),
    fetch: async () => { throw new Error('This test must not use the network') },
  })
  function load(name, imports) {
    let source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/lib/' + name + '.ts'), 'utf8')
    if (name === 'api') source = source.replace('import.meta.env.VITE_CLOUDNOTE_SERVER', 'undefined')
    const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
    const moduleObj = { exports: {} }
    vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(dep => {
      if (!(dep in imports)) throw new Error('Unexpected import: ' + dep)
      return imports[dep]
    }, moduleObj, moduleObj.exports)
    return moduleObj.exports
  }
  const account = load('accountStorage', {})
  const api = load('api', { './accountStorage': account })
  const store = load('store', {
    zustand: { create }, './api': api,
    './shortcuts': { SHORTCUTS: [], resolveBindings: () => [] },
    './viewport': { readViewport: () => 'desktop' },
  })
  const sync = load('sync', { './api': api, './store': store, './accountStorage': account })
  return { storage, account, api, sync, state: () => store.useStore.getState() }
}

function seedA() {
  const data = new Map()
  data.set('cloudnote.server', server)
  data.set('cloudnote.token', 'token-A')
  data.set('cloudnote.user', JSON.stringify(A))
  data.set(cacheKey, JSON.stringify({ lastSeq: 1, folders: {}, notes: { N: note('N', 'old A') }, cursorVersion: 2 }))
  return data
}
function pending(storage, id) {
  const rows = JSON.parse(storage.get(pendingKey) || '[]')
  return rows.find(([noteId]) => noteId === id)?.[1]
}

function relogin(h, user) {
  h.sync.activateAccount(server, user.id)
  h.api.session.save('token-' + user.id, user)
  h.state().setUser(user)
}

function main() {
  const h = harness(seedA())
  assert.equal(h.api.session.user?.id, A.id)
  h.sync.queueSave('N', { content: 'draft A', excerpt: 'draft A' })
  h.storage.set(queueKey, JSON.stringify([{ kind: 'folder.delete', id: 'A-only' }]))
  h.sync.suspendAccount()
  h.api.session.clear()
  assert.equal(h.api.session.user, null)
  assert.equal(pending(h.storage, 'N')?.content, 'draft A')

  // 真实 UI 会先 session.clear，再从登录页调用 activateAccount；第二次 suspend 不能清盘。
  relogin(h, A)
  assert.equal(h.state().notes.N.content, 'draft A')
  assert.equal(h.sync.hasPending('N'), true)
  assert.equal(pending(h.storage, 'N')?.content, 'draft A')
  assert.equal(JSON.parse(h.storage.get(queueKey)).length, 1)

  h.sync.suspendAccount()
  h.api.session.clear()
  relogin(h, B)
  assert.equal(h.state().notes.N, undefined)
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.storage.has(pendingKey), false)
  assert.equal(h.storage.has(queueKey), false)

  h.sync.suspendAccount()
  h.api.session.clear()
  relogin(h, A)
  assert.equal(h.state().notes.N.content, 'draft A')
  assert.equal(pending(h.storage, 'N')?.content, 'draft A')
  assert.equal(JSON.parse(h.storage.get(queueKey)).length, 1)

  // 重启且停在登录页：sync 的内存 pending 还没装载，activate 不得写空快照覆盖磁盘。
  h.sync.suspendAccount()
  h.api.session.clear()
  const afterRestart = harness(h.storage)
  assert.equal(afterRestart.api.session.user, null)
  assert.equal(pending(h.storage, 'N')?.content, 'draft A')
  relogin(afterRestart, A)
  assert.equal(afterRestart.state().notes.N.content, 'draft A')
  assert.equal(afterRestart.sync.hasPending('N'), true)
  assert.equal(pending(h.storage, 'N')?.content, 'draft A')

  console.log('跨模块账号退出、同号重登、换号隔离、切回恢复、登录页重启：通过')
}
main()
