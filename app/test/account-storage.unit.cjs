// 账号隔离的独立单元测试：执行真实模块，仅模拟 localStorage 与 fetch。
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const { transformSync } = require(path.resolve(__dirname, '../node_modules/esbuild'))

const values = new Map()
const localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
}
const requests = []
const context = vm.createContext({
  localStorage, console, Date, Math,
  fetch: async (url, init) => {
    requests.push({ url, ...init })
    return { ok: true, status: 200, json: async () => ({ token: 'new', user: { id: 'B' } }) }
  },
})
function load(name, imports = {}) {
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

async function main() {
  const A = { server: 'https://one.example', userId: 'A' }
  const B = { server: 'https://one.example', userId: 'B' }
  values.set('cloudnote.server', A.server)
  values.set('cloudnote.user', JSON.stringify({ id: A.userId }))
  values.set('cloudnote.cache', 'cache A')
  values.set('cloudnote.pending', 'draft A')
  values.set('cloudnote.queue', 'queue A')

  const scope = load('accountStorage')
  const api = load('api', { './accountStorage': scope })
  assert.deepEqual(JSON.parse(values.get('cloudnote.scope')), A)
  api.session.save('token A', { id: 'A' })
  api.session.clear()
  assert.equal(api.session.user, null)
  assert.deepEqual(JSON.parse(values.get('cloudnote.scope')), A)
  assert.equal(scope.activateAccountScope(A.server, A.userId).changed, false)
  assert.equal(values.get('cloudnote.pending'), 'draft A')

  assert.equal(scope.activateAccountScope(B.server, B.userId).changed, true)
  for (const key of ['cloudnote.cache', 'cloudnote.pending', 'cloudnote.queue']) {
    assert.equal(values.has(key), false, '新账号不应看到旧账号的 ' + key)
  }
  values.set('cloudnote.cache', 'cache B')
  values.set('cloudnote.pending', 'draft B')
  values.set('cloudnote.queue', 'queue B')
  scope.activateAccountScope(A.server, A.userId)
  assert.equal(values.get('cloudnote.cache'), 'cache A')
  assert.equal(values.get('cloudnote.pending'), 'draft A')
  assert.equal(values.get('cloudnote.queue'), 'queue A')
  scope.activateAccountScope(B.server, B.userId)
  assert.equal(values.get('cloudnote.pending'), 'draft B')

  // 模拟写活动键时被强杀：启动初始化必须完成目标账号的整组恢复。
  values.set('cloudnote.scopeSwitch', JSON.stringify(A))
  values.set('cloudnote.cache', 'partial')
  scope.initializeAccountScope('https://one.example')
  assert.equal(values.get('cloudnote.cache'), 'cache A')
  assert.equal(values.get('cloudnote.pending'), 'draft A')
  assert.deepEqual(JSON.parse(values.get('cloudnote.scope')), A)
  assert.equal(values.has('cloudnote.scopeSwitch'), false)
  scope.activateAccountScope(B.server, B.userId)
  assert.equal(values.get('cloudnote.pending'), 'draft B')

  // 切换完成、session.save 之前崩溃：旧 token/user 不能进入新账号工作区。
  values.set('cloudnote.token', 'token A')
  values.set('cloudnote.user', JSON.stringify({ id: A.userId }))
  assert.equal(api.session.user, null)
  values.set('cloudnote.scopeSwitch', JSON.stringify(A))
  scope.initializeAccountScope('https://one.example')
  assert.equal(api.session.user?.id, A.userId)
  scope.activateAccountScope(B.server, B.userId)
  assert.equal(api.session.user, null)

  // 同一 userId 在另一服务器上也必须单独隔离。
  scope.activateAccountScope('https://two.example', B.userId)
  assert.equal(values.has('cloudnote.pending'), false)
  scope.activateAccountScope(B.server, B.userId)
  assert.equal(values.get('cloudnote.pending'), 'draft B')

  api.session.save('stale token', { id: 'B' })
  await api.api.login('b@example.com', 'password')
  assert.equal(requests.at(-1).headers.authorization, undefined)
  await api.api.changePassword('old', 'new')
  assert.equal(requests.at(-1).headers.authorization, 'Bearer stale token')
  const epoch = scope.getAccountEpoch()
  api.session.server = 'https://two.example'
  assert.ok(scope.getAccountEpoch() > epoch)
  assert.equal(api.session.user, null, '同一用户在另一服务器上的凭证不能解锁当前 scope')
  console.log('账号归属迁移、换号/换服隔离、回切恢复、登出保留、auth 请求及 epoch：通过')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
