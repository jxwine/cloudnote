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

function harness(storage = new Map(), fetchImpl) {
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
    fetch: fetchImpl || (async () => { throw new Error('This test must not use the network') }),
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
  const readingLock = load('readingLock', {})
  const store = load('store', {
    zustand: { create }, './api': api,
    './readingLock': readingLock,
    './shortcuts': { SHORTCUTS: [], resolveBindings: () => [] },
    './viewport': { readViewport: () => 'desktop' },
  })
  const sync = load('sync', { './api': api, './store': store, './accountStorage': account, './readingLock': readingLock })
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
async function expiredRelogin() {
  let releaseOldPull
  const oldPull = new Promise(resolve => { releaseOldPull = resolve })
  const requests = []
  const response = (status, body) => ({ status, ok: status === 200, json: async () => body })
  const h = harness(seedA(), async (url, options) => {
    requests.push({ url, token: options.headers.authorization })
    if (options.headers.authorization === 'Bearer token-A') {
      if (options.method === 'GET') return oldPull
      return response(401, { error: 'expired token' })
    }
    if (options.method === 'PATCH') {
      const patch = JSON.parse(options.body)
      return response(200, { ...note('N', patch.content), version: 2, seq: 2 })
    }
    return response(200, { seq: 2, folders: [], notes: [] })
  })
  h.sync.queueSave('N', { content: 'desktop draft' })
  const stalePull = h.sync.pullDelta()
  await h.sync.flushNote('N')
  assert.equal(h.state().authExpired, 'expired token')
  h.sync.suspendAccount()
  h.api.session.clear()
  relogin(h, A)
  assert.equal(h.state().authExpired, null)
  await h.sync.syncNow()
  assert.equal(h.sync.hasPending(), false)
  assert.equal(h.state().notes.N.content, 'desktop draft')
  assert.equal(h.state().status, 'synced')
  assert.ok(requests.some(r => r.token === 'Bearer token-account-A' && r.url.endsWith('/api/notes/N')))
  releaseOldPull(response(401, { error: 'delayed old token failure' }))
  await stalePull
  assert.equal(h.state().authExpired, null)
  assert.equal(h.state().status, 'synced')
  console.log('PASS expired desktop session: relogin uploads draft with new token and ignores delayed old 401')
}
async function trashAcrossDevices() {
  // Real API, database and client modules; inject HTTP locally without a network server.
  const { pathToFileURL } = require('node:url')
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloudnote-trash-'))
  process.env.CLOUDNOTE_DB = path.join(directory, 'test.sqlite')
  process.env.CLOUDNOTE_UPLOADS = path.join(directory, 'uploads')
  process.env.CLOUDNOTE_RELEASES = path.join(directory, 'releases')
  process.env.CLOUDNOTE_SECRET = 'trash-test-only-secret'
  let app, db
  try {
    const serverRoot = path.resolve(__dirname, '../../server')
    const { default: Fastify } = await import(pathToFileURL(require.resolve('fastify', { paths: [serverRoot] })).href)
    const { default: routes } = await import(pathToFileURL(path.join(serverRoot, 'src/routes.js')).href)
    ;({ db } = await import(pathToFileURL(path.join(serverRoot, 'src/db.js')).href))
    app = Fastify()
    await app.register(routes)
    await app.ready()
    const request = async (method, url, token, payload) => {
      const res = await app.inject({ method, url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(payload === undefined ? {} : { payload }),
      })
      assert.equal(res.statusCode, 200, res.body)
      return res.json()
    }
    const owner = await request('POST', '/api/auth/register', null,
      { email: 'trash@test.local', password: 'password-123' })
    const created = await request('POST', '/api/notes', owner.token, { content: 'trash note' })
    await request('DELETE', `/api/notes/${created.id}`, owner.token)
    const before = await request('GET', '/api/sync/pull?since=0', owner.token)
    const seed = () => new Map([
      ['cloudnote.server', server], ['cloudnote.token', owner.token],
      ['cloudnote.user', JSON.stringify(owner.user)],
      [cacheKey, JSON.stringify({ lastSeq: before.seq, cursorVersion: 2,
        folders: {}, notes: Object.fromEntries(before.notes.map(row => [row.id, row])) })],
    ])
    const transport = async (url, options) => {
      const address = new URL(url)
      const res = await app.inject({ method: options.method, url: address.pathname + address.search,
        headers: options.headers, ...(options.body === undefined ? {} : { payload: options.body }),
      })
      return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => res.json() }
    }
    const offlineWeb = harness(seed(), transport)
    const staleWeb = harness(seed(), transport)
    await request('DELETE', `/api/notes/${created.id}/purge`, owner.token)
    // This reproduces the existing server: permanent deletion does not advance seq.
    const delta = await request('GET', `/api/sync/pull?since=${before.seq}`, owner.token)
    assert.equal(delta.seq, before.seq)
    assert.equal(delta.notes.length, 0)
    await offlineWeb.sync.syncNow()
    assert.equal(offlineWeb.state().notes[created.id], undefined)
    assert.equal(offlineWeb.state().status, 'synced')
    const restarted = harness(offlineWeb.storage, transport)
    assert.equal(restarted.state().notes[created.id], undefined)
    await assert.rejects(staleWeb.api.api.purgeNote(created.id), staleWeb.api.NotFoundError)
    await staleWeb.sync.purgeNote(created.id)
    assert.equal(staleWeb.state().notes[created.id], undefined)
    assert.equal(staleWeb.state().toast, null)
    console.log('PASS real server: desktop purge reconciles offline web trash; repeated web purge handles 404')
  } finally {
    if (app) await app.close()
    db?.close()
    for (const file of fs.readdirSync(directory)) {
      const target = path.join(directory, file)
      if (fs.statSync(target).isDirectory()) fs.rmdirSync(target)
      else fs.unlinkSync(target)
    }
    fs.rmdirSync(directory)
  }
}

;(async () => {
  main()
  await expiredRelogin()
  await trashAcrossDevices()
})().catch(error => { console.error(error); process.exitCode = 1 })
