// 阅读锁回归：执行真实锁链、搜索与导出模块，文件写入及 UI 提示使用替身。
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const { webcrypto, pbkdf2Sync } = require('node:crypto')
const { transformSync } = require('../node_modules/esbuild')

const context = vm.createContext({ console, crypto: webcrypto, TextEncoder, Uint8Array })
function load(name, imports = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/lib/' + name + '.ts'), 'utf8')
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const moduleObj = { exports: {} }
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(dep => {
    if (!(dep in imports)) throw new Error('Unexpected import: ' + dep)
    return imports[dep]
  }, moduleObj, moduleObj.exports)
  return moduleObj.exports
}
const locks = load('readingLock')
const search = load('search', { './readingLock': locks })
const plain = value => JSON.parse(JSON.stringify(value))
const target = (kind, id) => ({ kind, id })
const protection = revision => ({ salt: '00'.repeat(16), hash: '00'.repeat(32), iterations: 210000, revision })
const folder = (id, parentId = null, readingLock = null) => ({ id, name: id, parentId, readingLock, deleted: false })
const note = (id, folderId = null, readingLock = null) => ({
  id, title: id, content: '<p>needle secret</p>', updatedAt: 1, folderId, readingLock, deleted: false,
})
function fixture() {
  return {
    folders: {
      outer: folder('outer', null, protection('outer-v1')),
      inner: folder('inner', 'outer', protection('inner-v1')),
      sibling: folder('sibling', 'outer'),
      public: folder('public'),
    },
    notes: {
      secret: note('secret', 'inner', protection('note-v1')),
      sibling: note('sibling', 'sibling'),
      public: note('public', 'public'),
    },
    lockGrants: {},
  }
}

function checkTrashRecovery() {
  const state = fixture()
  state.notes.secret.deleted = true
  state.notes.secret.title = '不应泄露的已删标题'
  state.notes.secret.excerpt = '不应泄露的已删摘要'
  state.folders.outer.deleted = true
  state.activeNoteId = 'public'
  state.lockEpoch = 0
  state.lockScope = null
  const messages = []
  const purged = []
  let relocks = 0
  state.showToast = toast => messages.push(toast.message)
  state.relock = () => { relocks++; state.lockGrants = {}; state.lockEpoch++ }
  const useStore = selector => selector ? selector(state) : state
  useStore.getState = () => state
  useStore.setState = patch => Object.assign(state, patch)
  const cells = []
  let cursor = 0
  let effects = []
  const jsx = (type, props) => ({ type, props })
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/components/Trash.tsx'), 'utf8')
  const code = transformSync(source, { loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022' }).code
  const imports = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    react: {
      useState: initial => { const slot = cursor++; if (!(slot in cells)) cells[slot] = initial; return [cells[slot], value => { cells[slot] = typeof value === 'function' ? value(cells[slot]) : value }] },
      useMemo: callback => callback(),
      useEffect: callback => { effects.push(callback) },
    },
    '@/lib/store': { useStore },
    '@/lib/sync': { purgeNote: id => purged.push(id), restoreNote: id => { state.notes[id].deleted = false } },
    '@/lib/search': search,
    '@/lib/readingLock': locks,
    './ReadingLock': { ReadingLockPane: 'reading-lock-pane' },
    './Icons': Object.fromEntries(['IconChevron', 'IconClose', 'IconFolder', 'IconLock', 'IconNote', 'IconRestore', 'IconTrash'].map(name => [name, name])),
  }
  const moduleObj = { exports: {} }
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(dep => {
    if (!(dep in imports)) throw new Error('Unexpected component import: ' + dep)
    return imports[dep]
  }, moduleObj, moduleObj.exports)
  const render = () => { cursor = 0; effects = []; const tree = moduleObj.exports.Trash(); effects.forEach(callback => callback()); return tree }
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' ? [node, ...walk(node.props?.children)] : []
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
  const button = (tree, label) => walk(tree).find(node => node.type === 'button' && text(node) === label)
  let tree = render()
  assert.match(text(tree), /受密码保护的笔记/)
  assert.doesNotMatch(text(tree), /不应泄露|outer|inner/, '回收站锁定占位不能包含标题、摘要或目录路径')
  assert.equal(button(tree, '放回去'), undefined)
  button(tree, '清空').props.onClick()
  assert.equal(purged.length, 0, '清空回收站不能绕过锁定项目')
  assert.equal(messages.length, 1)
  button(tree, '解锁后管理').props.onClick()
  assert.deepEqual(plain(state.lockScope), target('note', 'secret'))
  assert.equal(state.activeNoteId, 'public', '回收站解锁不能触发手机端跳入已删除笔记')
  tree = render()
  let modal = walk(tree).find(node => typeof node.type === 'function' && node.type.name === 'TrashUnlockDialog')
  assert.ok(modal, '已删除笔记必须有可进入的解锁层')
  let modalTree = modal.type(modal.props)
  assert.deepEqual(plain(walk(modalTree).find(node => node.type === 'reading-lock-pane').props.target), target('note', 'secret'),
    '传入原笔记目标才能逐层验证目录及独立笔记锁')
  state.lockGrants['folder:outer'] = 'outer-v1'
  walk(modalTree).find(node => node.props?.['aria-label'] === '关闭解锁').props.onClick()
  assert.equal(relocks, 1, '未完成解锁即关闭应撤销部分授权')
  assert.deepEqual(state.lockGrants, {})

  tree = render()
  button(tree, '解锁后管理').props.onClick()
  state.lockGrants = { 'folder:outer': 'outer-v1', 'folder:inner': 'inner-v1', 'note:secret': 'note-v1' }
  tree = render()
  assert.ok(button(tree, '放回去'), '逐层解锁后恢复和删除操作可用')
  assert.equal(walk(tree).some(node => typeof node.type === 'function' && node.type.name === 'TrashUnlockDialog'), false)
  assert.equal(relocks, 1, '完成解锁自动关闭弹层时应保留授权以供恢复操作')
  button(tree, '放回去').props.onClick()
  assert.equal(state.notes.secret.deleted, false)
  assert.equal(state.activeNoteId, 'public', '恢复后也不能隐式跳转手机编辑页')
}

async function main() {
  assert.equal(locks.maskReadingTitle('个人笔记'), '个**记')
  assert.equal(locks.maskReadingTitle('账户'), '账*')
  assert.equal(locks.maskReadingTitle('密'), '*')
  assert.equal(locks.maskReadingTitle('🔐秘密📔'), '🔐**📔')
  const titles = fixture()
  assert.equal(locks.readingTitle(titles, target('folder', 'outer')), 'o**r')
  assert.equal(locks.readingTitle(titles, target('folder', 'inner')), '受密码保护的目录')
  assert.equal(locks.readingTitle(titles, target('note', 'secret')), '受密码保护的笔记')
  titles.lockGrants = { 'folder:outer': 'outer-v1', 'folder:inner': 'inner-v1' }
  assert.equal(locks.readingTitle(titles, target('note', 'secret')), 's**t')
  titles.lockGrants['note:secret'] = 'note-v1'
  assert.equal(locks.readingTitle(titles, target('note', 'secret')), 'secret')
  titles.notes.secret.readingLock = protection('note-v2')
  assert.equal(locks.readingTitle(titles, target('note', 'secret')), 's**t')
  assert.equal(titles.notes.secret.title, 'secret', '标题脱敏不能修改原始内容')
  const state = fixture()
  const secret = target('note', 'secret')
  assert.deepEqual(plain(locks.lockChain(state, secret)), [target('folder', 'outer'), target('folder', 'inner'), secret])
  assert.equal(locks.blockedLock(state, secret).id, 'outer', '应先验证最外层目录')
  state.lockGrants['folder:outer'] = 'outer-v1'
  assert.equal(locks.blockedLock(state, secret).id, 'inner')
  state.lockGrants['folder:inner'] = 'inner-v1'
  assert.equal(locks.blockedLock(state, secret).id, 'secret', '目录解锁不能绕过独立笔记密码')
  state.lockGrants['note:secret'] = 'note-v1'
  assert.equal(locks.canReadNote(state, state.notes.secret), true)
  assert.equal(locks.hasReadingLock(state, secret), true, '已解锁仍应显示密码管理入口')
  assert.equal(locks.hasReadingLock(state, target('note', 'public')), false)

  state.folders.outer.deleted = true
  delete state.lockGrants['folder:outer']
  assert.equal(locks.canReadNote(state, state.notes.secret), false, '删除祖先目录不能让回收站里的后代绕过密码')
  state.lockGrants['folder:outer'] = 'outer-v1'
  state.notes.secret.readingLock = protection('note-v2')
  assert.equal(locks.canReadNote(state, state.notes.secret), false, '远端重设密码后旧授权立即失效')
  state.lockGrants['note:secret'] = 'note-v2'

  assert.deepEqual(plain(locks.retainedGrants(state, target('note', 'sibling'))), { 'folder:outer': 'outer-v1' },
    '在同一祖先范围切换时只保留共用祖先授权')
  assert.deepEqual(plain(locks.retainedGrants(state, target('folder', 'inner'))), {
    'folder:outer': 'outer-v1', 'folder:inner': 'inner-v1',
  }, '退出独立笔记后撤销笔记授权，保留当前目录祖先')
  assert.deepEqual(plain(locks.retainedGrants(state, target('note', 'public'))), {})
  assert.deepEqual(plain(locks.retainedGrants(state, null)), {}, '退出阅读范围后应全部重新锁定')
  state.folders.inner.readingLock = protection('inner-v2')
  assert.equal(locks.retainedGrants(state, secret)['folder:inner'], undefined, '过期授权不得被保留')

  const defaultHits = search.searchNotes('needle', state.notes, state.folders)
  assert.deepEqual(plain(defaultHits.map(hit => hit.note.id)), ['public'], '不传授权的检索默认隐藏所有受保护内容')
  assert.equal(search.searchNotes('secret', { secret: state.notes.secret }, state.folders).length, 0,
    '标题和正文的命中次数、摘要均不得暴露')
  state.lockGrants['folder:inner'] = 'inner-v2'
  assert.equal(search.searchNotes('needle', state.notes, state.folders, 200, state.lockGrants).length, 3)
  delete state.lockGrants['folder:outer']
  assert.equal(search.searchNotes('needle', state.notes, state.folders, 200, state.lockGrants).length, 1,
    '重新锁定后缓存过的搜索正文也不能返回')
  state.folders.outer.parentId = 'inner'
  assert.ok(locks.lockChain(state, secret).length <= 3, '异常循环目录不能导致权限检查死循环')
  state.folders.outer.parentId = null

  const outputs = []
  const messages = []
  state.showToast = toast => messages.push(toast.message)
  const exporter = load('export', {
    './readingLock': locks,
    './search': search,
    './store': { useStore: { getState: () => state } },
    './markdown': { safeFileName: text => text, htmlToMarkdown: text => text, noteToMarkdownFile: note => note.content },
    './platform': { isDesktop: true, isNative: false, desktop: {
      exportFile: async (name, content) => { outputs.push({ name, content }); return { ok: false } },
      exportFolder: async files => { outputs.push(files); return { ok: false } },
    } },
  })
  await exporter.exportNote({ ...state.notes.secret, readingLock: null })
  assert.equal(outputs.length, 0, '旧对象不能绕过当前实时权限')
  await exporter.exportAll()
  await exporter.exportAll({ folderId: 'outer' })
  assert.equal(outputs.length, 0, '混有受保护笔记的批量导出应整体拒绝')
  assert.equal(messages.length, 3, '拒绝导出需要明确提示，不能静默导出部分内容')
  await exporter.exportAll({ folderId: 'public' })
  assert.equal(outputs.length, 1, '不受保护目录仍可正常导出')
  state.lockGrants['folder:outer'] = 'outer-v1'
  await exporter.exportAll({ folderId: 'outer' })
  assert.equal(outputs.length, 2, '所需授权均有效后可导出整个目录')
  state.notes.secret.content = '<p>latest</p>'
  await exporter.exportNote({ ...state.notes.secret, content: '<p>stale</p>' })
  assert.equal(outputs[2].content, '<p>latest</p>', '导出使用当前账号中的最新对象')

  const password = '阅读密码-正确'
  const lock = protection('crypto-v1')
  lock.hash = pbkdf2Sync(password, Buffer.from(lock.salt, 'hex'), lock.iterations, 32, 'sha256').toString('hex')
  assert.equal(await locks.verifyReadingPassword(lock, password), true)
  assert.equal(await locks.verifyReadingPassword(lock, '错误密码'), false)
  await assert.rejects(locks.verifyReadingPassword({ ...lock, iterations: 1 }, password), /密码数据无效/)
  await assert.rejects(locks.verifyReadingPassword({ ...lock, salt: 'invalid' }, password), /密码数据无效/)
  checkTrashRecovery()
  console.log('reading-lock.unit: PASS (锁链、密码修订、范围切换、软删祖先、搜索与导出保护、密码验证、回收站解锁恢复)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
