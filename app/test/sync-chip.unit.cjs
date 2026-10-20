// 执行真实同步组件，验证各端共用的状态展示与手动入口语义。
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const { transformSync } = require('../node_modules/esbuild')

const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/components/SyncChip.tsx'), 'utf8')
const code = transformSync(source, {
  loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic',
}).code

function harness(initial = {}) {
  let state = {
    status: 'synced', peers: 0, authExpired: null, dirtyNoteId: null, manualSyncing: false,
    ...initial,
  }
  let calls = 0
  let finish
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const IconRefresh = () => jsx('svg', {})
  const imports = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@/lib/store': { useStore: select => select(state) },
    '@/lib/sync': { syncManually: () => {
      calls++
      state = { ...state, manualSyncing: true }
      return new Promise(resolve => { finish = () => {
        state = { ...state, manualSyncing: false }
        resolve()
      } })
    } },
    './Icons': { IconRefresh },
  }
  const context = vm.createContext({ console })
  function newView() {
    const module = { exports: {} }
    vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(name => {
      if (!(name in imports)) throw new Error('Unexpected import: ' + name)
      return imports[name]
    }, module, module.exports)
    return () => module.exports.SyncChip()
  }
  return {
    render: newView(), newView, IconRefresh,
    setState: patch => { state = { ...state, ...patch } },
    calls: () => calls,
    finish: () => finish?.(),
  }
}

function descendants(node) {
  if (node == null || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap(descendants)
  if (typeof node !== 'object') return [node]
  return [node, ...descendants(node.props?.children)]
}
const hasClass = (node, name) => typeof node === 'object' && node.props?.className?.split(/\s+/).includes(name)
function controls(tree) {
  const nodes = descendants(tree)
  return {
    status: nodes.find(node => hasClass(node, 'sync-chip')),
    button: nodes.find(node => hasClass(node, 'sync-manual')),
    dot: nodes.find(node => hasClass(node, 'sync-dot')),
    buttons: nodes.filter(node => typeof node === 'object' && node.type === 'button'),
  }
}
const text = node => descendants(node).filter(value => typeof value === 'string' || typeof value === 'number').join('')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('状态是可读信息，旁边只有一个无文字的图标操作入口', () => {
  const h = harness({ peers: 2 })
  const ui = controls(h.render())
  assert.equal(ui.status.type, 'span')
  assert.equal(ui.status.props.role, 'status')
  assert.equal(typeof ui.status.props.onClick, 'undefined')
  assert.match(text(ui.status), /已同步/)
  assert.match(text(ui.status), /3 端/)
  assert.equal(ui.buttons.length, 1)
  assert.equal(ui.button.type, 'button')
  assert.equal(ui.button.props['aria-label'], '手动同步')
  assert.equal(ui.button.props.disabled, false)
  assert.equal(ui.button.props['aria-busy'], false)
  assert.equal(text(ui.button), '')
  assert.ok(descendants(ui.button).some(node => node?.type === h.IconRefresh))
})

test('自动同步与连接时保留真实状态，手动图标仍可点击且不表示手动忙碌', () => {
  for (const [status, label] of [['syncing', '同步中'], ['connecting', '连接中']]) {
    const h = harness({ status })
    const ui = controls(h.render())
    assert.match(text(ui.status), new RegExp(label))
    assert.equal(ui.button.props.disabled, false)
    assert.equal(ui.button.props['aria-busy'], false)
    assert.equal(ui.button.props['aria-label'], '手动同步')
    ui.button.props.onClick()
    assert.equal(h.calls(), 1)
    h.finish()
  }
})

test('手动同步处理中禁用图标，离线或错误状态仍然可见', () => {
  for (const [status, label] of [['syncing', '同步中'], ['offline', '离线'], ['error', '同步失败']]) {
    const h = harness({ status, manualSyncing: true })
    const ui = controls(h.render())
    assert.match(text(ui.status), new RegExp(label))
    assert.ok(hasClass(ui.dot, status))
    assert.equal(ui.button.props.disabled, true)
    assert.equal(ui.button.props['aria-busy'], true)
    assert.equal(ui.button.props['aria-label'], '同步中')
  }
})

test('离线与失败都通过同一个手动图标重试', () => {
  for (const status of ['offline', 'error']) {
    const h = harness({ status })
    const ui = controls(h.render())
    assert.equal(ui.buttons.length, 1)
    assert.equal(ui.status.type, 'span')
    assert.equal(ui.button.props.disabled, false)
    ui.button.props.onClick()
    assert.equal(h.calls(), 1)
    h.finish()
  }
})

test('已同步但仍有本地草稿时显示待同步，失败与离线不被草稿状态遮盖', () => {
  const h = harness({ dirtyNoteId: 'note-1' })
  const ui = controls(h.render())
  assert.match(text(ui.status), /待同步/)
  assert.ok(hasClass(ui.dot, 'pending'))
  assert.equal(ui.button.props.disabled, false)
  for (const [status, label] of [['offline', '离线'], ['error', '同步失败']]) {
    h.setState({ status })
    const next = controls(h.render())
    assert.match(text(next.status), new RegExp(label))
    assert.ok(hasClass(next.dot, status))
  }
})

test('登录失效优先显示并阻止手动操作', () => {
  for (const manualSyncing of [false, true]) {
    const h = harness({ status: 'syncing', dirtyNoteId: 'note-1', manualSyncing, authExpired: '会话已过期' })
    const ui = controls(h.render())
    assert.match(text(ui.status), /登录失效/)
    assert.ok(hasClass(ui.dot, 'error'))
    assert.equal(ui.button.props.disabled, true)
    assert.match(ui.button.props.title, /登录/)
    assert.equal(ui.button.props['aria-busy'], manualSyncing)
  }
})

test('跨视图重新挂载沿用共享手动同步状态，完成后所有视图恢复可用', () => {
  const h = harness()
  controls(h.render()).button.props.onClick()
  assert.equal(h.calls(), 1)
  const mobileView = h.newView()
  for (const render of [h.render, mobileView]) {
    const ui = controls(render())
    assert.equal(ui.button.props.disabled, true)
    assert.equal(ui.button.props['aria-busy'], true)
  }
  h.finish()
  for (const render of [h.render, mobileView]) {
    const ui = controls(render())
    assert.equal(ui.button.props.disabled, false)
    assert.equal(ui.button.props['aria-busy'], false)
  }
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
