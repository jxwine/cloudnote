// 执行真实导出编排、锁链、文件分配和弹窗状态；系统保存、DOM 下载与 Word 转换使用可控替身。
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { transformSync } = require('../node_modules/esbuild')

const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const note = (id, folderId = null, title = id) => ({
  id, folderId, title, content: '<p>正文</p>', tags: [], updatedAt: 1, deleted: false,
})
const folder = (id, name = id, parentId = null) => ({ id, name, parentId, deleted: false })
const binary = Uint8Array.from([0x50, 0x4b, 0, 0xff, 0x80])

function load(name, context, imports = {}) {
  const filename = path.resolve(__dirname, '../src/renderer/src/lib/' + name + '.ts')
  const code = transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022', supported: { 'dynamic-import': false },
  }).code
  const module = { exports: {} }
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context, { filename })(dep => {
    if (!(dep in imports)) throw new Error('Unexpected import: ' + dep)
    return imports[dep]
  }, module, module.exports)
  return module.exports
}

function harness(options = {}) {
  const state = {
    user: { id: 'account-a' }, notes: { one: note('one') }, folders: {}, lockEpoch: 0, lockGrants: {},
  }
  let epoch = 0
  const dialogs = [], saves = [], downloads = [], toasts = [], writes = [], shares = [], conversions = []
  const targets = [], commits = []
  state.showToast = toast => toasts.push(toast)
  let blob
  const context = vm.createContext({
    console, Blob, Uint8Array, ArrayBuffer,
    setTimeout: () => 1,
    URL: { createObjectURL: value => { blob = value; return 'blob:test' }, revokeObjectURL: () => {} },
    document: {
      body: { append: () => {} },
      createElement: () => ({ click() { downloads.push({ name: this.download, blob }) }, remove() {} }),
    },
    FileReader: class {
      readAsDataURL(value) {
        value.arrayBuffer().then(buffer => {
          this.result = 'data:application/octet-stream;base64,' + Buffer.from(buffer).toString('base64')
          this.onload()
        }).catch(error => { this.error = error; this.onerror() })
      }
    },
    window: {},
  })
  const markdown = load('markdown', context)
  const formats = load('exportFormats', context, { './markdown': markdown })
  const locks = load('readingLock', context)
  const desktop = {
    exportBinary: true,
    exportFile: async (name, content) => { saves.push({ name, content }); return options.saveResult || { ok: false } },
    exportFolder: async files => { saves.push({ files }); return options.saveResult || { ok: false } },
    reveal: () => {},
  }
  if (options.oldDesktop) delete desktop.exportBinary
  if (options.twoPhase) {
    desktop.chooseExportTarget = async (name, bulk) => {
      targets.push({ name, bulk })
      return options.target ? options.target(name, bulk) : { ticket: 'export-ticket', path: 'D:/chosen/export' }
    }
    desktop.writeExportTarget = async (ticket, files) => {
      commits.push({ ticket, files })
      return options.saveResult || { ok: true, path: 'D:/chosen/export', count: files.length }
    }
  }
  const plugins = options.missingPlugins ? {} : {
    Filesystem: { writeFile: async value => {
      writes.push(value)
      await options.write?.()
      return { uri: 'content://export/document' }
    } },
    Share: { share: async value => { shares.push(value); await options.share?.() } },
  }
  context.window.Capacitor = { Plugins: plugins }
  const exporter = load('export', context, {
    './readingLock': locks,
    './store': { useStore: { getState: () => state } },
    './markdown': { ...markdown, noteToMarkdownFile: value => `MD:${value.title}:${value.content}` },
    './platform': { isDesktop: options.platform === 'desktop', isNative: options.platform === 'android', desktop },
    './exportDialog': { chooseExportFormat: async (title, bulk) => {
      dialogs.push({ title, bulk })
      return options.choose ? options.choose() : options.format || 'md'
    } },
    './exportFormats': { ...formats, noteToText: value => `TXT:${value.title}:${value.content}` },
    './accountStorage': { getAccountEpoch: () => epoch },
    './sync': { prepareForExport: () => options.prepare?.(state) },
    './word': { notesToWord: async entries => {
      conversions.push(entries)
      return options.word ? options.word(entries) : binary
    } },
  })
  return {
    exporter, formats, state, dialogs, saves, downloads, toasts, writes, shares, conversions, targets, commits,
    switchAccount: () => { epoch++; state.user = { id: 'account-b' } },
    exportOne: () => exporter.exportNote(state.notes.one),
  }
}

const tests = []
const test = (name, run) => tests.push({ name, run })

test('单篇和批量入口均先选择格式，取消没有文件副作用', async () => {
  const h = harness({ choose: () => null, platform: 'desktop' })
  await h.exportOne()
  await h.exporter.exportAll()
  assert.deepEqual(h.dialogs, [{ title: '导出', bulk: false }, { title: '全部导出', bulk: true }])
  assert.equal(h.saves.length + h.downloads.length + h.writes.length, 0)
})

test('已锁定笔记和混合批量在弹窗前拒绝，旧对象不能绕过', async () => {
  const h = harness()
  h.state.notes.one.readingLock = { revision: 'r1' }
  h.state.notes.two = note('two')
  await h.exporter.exportNote({ ...h.state.notes.one, readingLock: null })
  await h.exporter.exportAll()
  assert.equal(h.dialogs.length, 0)
  assert.equal(h.toasts.length, 2)
  assert.match(h.toasts[0].message, /解锁/)
  assert.equal(h.downloads.length, 0)
})

test('确认后结算草稿并重新读取当前笔记，不使用点击时快照', async () => {
  const h = harness({ platform: 'desktop', prepare: state => {
    state.notes.one = { ...state.notes.one, title: '新标题', content: '最新输入法正文' }
  } })
  await h.exporter.exportNote({ ...h.state.notes.one, content: '过期正文' })
  assert.equal(h.saves[0].name, '新标题.md')
  assert.match(h.saves[0].content, /最新输入法正文/)
})

test('弹窗期间换账号或新上锁不得继续导出', async () => {
  for (const action of ['account', 'lock']) {
    const gate = deferred()
    const h = harness({ choose: () => gate.promise })
    const running = h.exportOne()
    if (action === 'account') h.switchAccount()
    else h.state.notes.one.readingLock = { revision: 'r1' }
    gate.resolve('md')
    await running
    assert.equal(h.downloads.length, 0)
    if (action === 'lock') assert.match(h.toasts[0].message, /解锁/)
  }
})

test('空范围和已删除目录明确拒绝，根目录筛选不包含子目录', async () => {
  const h = harness({ platform: 'desktop' })
  h.state.folders.child = folder('child')
  h.state.notes.two = note('two', 'child')
  await h.exporter.exportAll({ folderId: null })
  assert.equal(h.saves[0].files.length, 1)
  assert.equal(h.saves[0].files[0].path, 'one.md')
  await h.exporter.exportAll({ folderId: 'missing' })
  h.state.notes = {}
  await h.exporter.exportAll()
  assert.match(h.toasts[0].message, /目录已删除/)
  assert.match(h.toasts[1].message, /没有可导出/)
})

test('目录范围包含后代，批量排除已删笔记，输出层级和同名文件', async () => {
  const h = harness({ platform: 'desktop' })
  h.state.folders = { a: folder('a', '目录'), b: folder('b', '子目录', 'a') }
  h.state.notes = {
    one: note('one', 'a', '笔记'), two: note('two', 'a', '笔记'),
    three: note('three', 'b'), root: note('root'), deleted: { ...note('deleted', 'a'), deleted: true },
  }
  await h.exporter.exportAll({ folderId: 'a' })
  assert.deepEqual(plain(h.saves[0].files.map(file => file.path)), ['目录/笔记.md', '目录/笔记 (2).md', '目录/子目录/three.md'])
})

test('文件名兼容 Windows，大小写和清理后的重名目录不混合', () => {
  const h = harness()
  const folders = { a: folder('a', 'A/B'), b: folder('b', 'a:b'), c: folder('c', 'note.md') }
  const entries = h.formats.exportEntries([
    note('a', 'a', 'CON'), note('b', 'b', 'nul.txt'), note('c', null, 'note'),
    note('d', 'c', 'x'), note('e', null, 'NOTE'), note('f', null, '..'),
  ], folders, 'md')
  const paths = plain(entries.map(entry => entry.path))
  assert.deepEqual(paths, ['A-B/_CON.md', 'a-b (2)/_nul.txt.md', 'note (2).md', 'note.md/x.md', 'NOTE (3).md', '无标题.md'])
  assert.equal(new Set(paths.map(value => value.toLowerCase())).size, paths.length)
  for (const path of paths) assert.ok(path.split('/').every(segment => segment !== '..' && segment !== '.'))
  assert.equal(h.formats.exportName('hello.  '), 'hello')
  assert.equal(h.formats.exportName('COM1'), '_COM1')
  assert.equal(h.formats.exportName('a\u0000b'), 'a-b')
})

test('异常循环目录不能让文件分配死循环', () => {
  const h = harness()
  const entries = h.formats.exportEntries([note('one', 'a')], { a: folder('a', 'a', 'b'), b: folder('b', 'b', 'a') }, 'docx')
  assert.match(entries[0].path, /one\.docx$/)
  assert.ok(entries[0].path.split('/').length <= 3)
})

for (const format of ['md', 'txt', 'docx']) {
  test(`桌面单篇 ${format} 保留正确扩展名和原始内容类型`, async () => {
    const h = harness({ platform: 'desktop', format })
    await h.exportOne()
    assert.equal(h.saves[0].name, `one.${format}`)
    if (format === 'docx') assert.deepEqual([...h.saves[0].content], [...binary])
    else {
      assert.equal(typeof h.saves[0].content, 'string')
      assert.equal(h.saves[0].content.startsWith('\uFEFF'), format === 'txt')
    }
  })
  test(`浏览器批量 ${format} 合并为一个文件且 MIME 正确`, async () => {
    const h = harness({ format })
    h.state.folders.a = folder('a', '目录')
    h.state.notes.two = note('two', 'a')
    await h.exporter.exportAll()
    assert.equal(h.downloads.length, 1)
    assert.equal(h.downloads[0].name, `云笔记导出.${format}`)
    assert.equal(h.downloads[0].blob.type, h.formats.EXPORT_MIME[format])
    if (format === 'docx') {
      assert.equal(h.conversions[0].length, 2)
      assert.equal(h.conversions[0][1].path, '目录/two.docx')
      assert.deepEqual([...new Uint8Array(await h.downloads[0].blob.arrayBuffer())], [...binary])
    } else {
      const text = await h.downloads[0].blob.text()
      assert.match(text, new RegExp(`目录/two\\.${format}`))
      assert.match(text, /MD:one|TXT:one/)
    }
  })
}

test('桌面批量 Word 每篇独立生成二进制并保留目录结构', async () => {
  const h = harness({ platform: 'desktop', format: 'docx' })
  h.state.folders.a = folder('a', '目录')
  h.state.notes.two = note('two', 'a')
  await h.exporter.exportAll()
  assert.equal(h.conversions.length, 2)
  assert.ok(h.conversions.every(entries => entries.length === 1))
  assert.deepEqual(plain(h.saves[0].files.map(file => file.path)), ['one.docx', '目录/two.docx'])
  assert.ok(h.saves[0].files.every(file => file.content instanceof Uint8Array))
})

test('旧桌面桥只走原有 Markdown，TXT/Word 通过下载回退', async () => {
  for (const format of ['md', 'txt', 'docx']) {
    const h = harness({ platform: 'desktop', format, oldDesktop: true })
    await h.exportOne()
    assert.equal(h.saves.length, format === 'md' ? 1 : 0)
    assert.equal(h.downloads.length, format === 'md' ? 0 : 1)
  }
})

test('未加阅读锁的范围在原生位置选择期间仅发生失焦重锁代数变化仍可写入', async () => {
  const gate = deferred()
  const h = harness({ platform: 'desktop', twoPhase: true, target: () => gate.promise })
  const running = h.exportOne()
  await tick()
  assert.equal(h.targets.length, 1)
  assert.equal(h.state.notes.one.readingLock, undefined)
  assert.deepEqual(h.state.lockGrants, {})
  // 没有添加阅读锁或授权；模拟普通窗口失焦引发 relock() 只增加代数。
  h.state.lockEpoch++
  gate.resolve({ ticket: 'after-blur', path: 'D:/chosen/export' })
  await running
  assert.equal(h.commits.length, 1)
  assert.equal(h.commits[0].ticket, 'after-blur')
  assert.equal(h.saves.length + h.downloads.length + h.writes.length, 0)
  assert.match(h.toasts[0].message, /已导出到/)
})

function protectedScope(h, bulk) {
  h.state.folders.a = { ...folder('a', '受保护目录'), readingLock: { revision: 'folder-r1' } }
  h.state.notes.one = { ...h.state.notes.one, folderId: 'a', readingLock: { revision: 'note-r1' } }
  h.state.lockGrants = { 'folder:a': 'folder-r1', 'note:one': 'note-r1' }
  if (bulk) h.state.notes.two = note('two', 'a')
}

test('已解锁范围在原生位置选择时自动清除授权仍可完成一次导出，界面保持锁定', async () => {
  for (const bulk of [false, true]) {
    const gate = deferred()
    const h = harness({ platform: 'desktop', twoPhase: true, target: () => gate.promise })
    protectedScope(h, bulk)
    const running = bulk ? h.exporter.exportAll() : h.exportOne()
    await tick()
    assert.equal(h.targets.length, 1)
    h.state.lockGrants = {}
    h.state.lockEpoch++
    gate.resolve({ ticket: 'authorized-once', path: 'D:/chosen/export' })
    await running
    assert.equal(h.commits.length, 1)
    assert.equal(h.commits[0].ticket, 'authorized-once')
    assert.deepEqual(h.state.lockGrants, {}, '一次性导出不能恢复界面阅读授权')
    await (bulk ? h.exporter.exportAll() : h.exportOne())
    assert.equal(h.targets.length, 1, '下一次导出必须重新解锁，不能复用一次性授权')
    assert.equal(h.commits.length, 1)
  }
})

test('原生位置选择期间清授权并改变笔记或祖先锁修订，拒绝已确认的导出', async () => {
  for (const bulk of [false, true]) {
    for (const change of ['note-revision', 'folder-revision', 'remove-lock', 'move-lock-chain']) {
      const gate = deferred()
      const h = harness({ platform: 'desktop', twoPhase: true, target: () => gate.promise })
      protectedScope(h, bulk)
      const running = bulk ? h.exporter.exportAll() : h.exportOne()
      await tick()
      assert.equal(h.targets.length, 1)
      h.state.lockGrants = {}
      h.state.lockEpoch++
      if (change === 'note-revision') h.state.notes.one.readingLock = { revision: 'note-r2' }
      else if (change === 'folder-revision') h.state.folders.a.readingLock = { revision: 'folder-r2' }
      else if (change === 'remove-lock') h.state.notes.one.readingLock = null
      else {
        h.state.folders.b = { ...folder('b', '另一受保护目录'), readingLock: { revision: 'folder-r1' } }
        h.state.notes.one.folderId = 'b'
      }
      gate.resolve({ ticket: 'changed-lock', path: 'D:/chosen/export' })
      await running
      assert.equal(h.commits.length + h.saves.length + h.downloads.length + h.writes.length, 0, `锁设置变化应取消：${change}`)
      assert.match(h.toasts[0].message, /权限已变化/)
    }
  }
})

test('受保护范围在 Word 转换期间清除阅读授权，必须拒绝且不能进入系统位置选择', async () => {
  for (const bulk of [false, true]) {
    const gate = deferred()
    const h = harness({ platform: 'desktop', format: 'docx', twoPhase: true, word: () => gate.promise })
    protectedScope(h, bulk)
    const running = bulk ? h.exporter.exportAll() : h.exportOne()
    await tick()
    assert.equal(h.conversions.length, 1)
    h.state.lockGrants = {}
    h.state.lockEpoch++
    gate.resolve(binary)
    await running
    assert.equal(h.targets.length + h.commits.length + h.saves.length + h.downloads.length + h.writes.length, 0)
    assert.match(h.toasts[0].message, /权限已变化/)
  }
})

test('受保护范围在原生位置选择期间换账号或删除笔记，不能使用单次导出授权', async () => {
  for (const bulk of [false, true]) {
    for (const action of ['account', 'delete']) {
      const gate = deferred()
      const h = harness({ platform: 'desktop', twoPhase: true, target: () => gate.promise })
      protectedScope(h, bulk)
      const running = bulk ? h.exporter.exportAll() : h.exportOne()
      await tick()
      assert.equal(h.targets.length, 1)
      h.state.lockGrants = {}
      if (action === 'account') h.switchAccount()
      else h.state.notes.one.deleted = true
      gate.resolve({ ticket: 'stale-operation', path: 'D:/chosen/export' })
      await running
      assert.equal(h.commits.length + h.saves.length + h.downloads.length + h.writes.length, 0)
      if (action === 'account') assert.equal(h.toasts.length, 0)
      else assert.match(h.toasts[0].message, /权限已变化/)
    }
  }
})

for (const bulk of [false, true]) {
  for (const format of ['md', 'txt', 'docx']) test(`新桌面桥 ${bulk ? '批量' : '单篇'} ${format} 分两阶段提交，不调用旧接口`, async () => {
    const h = harness({ platform: 'desktop', format, twoPhase: true })
    if (bulk) {
      h.state.folders.a = folder('a', '目录')
      h.state.notes.two = note('two', 'a')
      await h.exporter.exportAll()
    } else await h.exportOne()
    const name = bulk ? `云笔记导出.${format}` : `one.${format}`
    assert.deepEqual(h.targets, [{ name, bulk }])
    assert.equal(h.commits.length, 1)
    assert.equal(h.commits[0].ticket, 'export-ticket')
    const files = h.commits[0].files
    assert.deepEqual(plain(files.map(file => file.path)), bulk ? [`one.${format}`, `目录/two.${format}`] : [name])
    if (format === 'docx') assert.ok(files.every(file => file.content instanceof Uint8Array))
    else assert.ok(files.every(file => typeof file.content === 'string'))
    assert.equal(h.saves.length + h.downloads.length + h.writes.length, 0)
    assert.match(h.toasts[0].message, /D:\/chosen\/export/)
  })

  test(`新桌面桥 ${bulk ? '批量' : '单篇'} 原生位置选择取消不写入`, async () => {
    const h = harness({ platform: 'desktop', format: 'docx', twoPhase: true, target: () => null })
    if (bulk) await h.exporter.exportAll()
    else await h.exportOne()
    assert.equal(h.targets.length, 1)
    assert.equal(h.commits.length + h.saves.length + h.downloads.length + h.writes.length, 0)
    assert.equal(h.toasts.length, 0)
  })

  test(`新桌面桥 ${bulk ? '批量' : '单篇'} 等待原生对话框时上锁、换账号或删除不得提交`, async () => {
    for (const action of ['lock', 'account', 'delete']) {
      const gate = deferred()
      const h = harness({ platform: 'desktop', format: 'docx', twoPhase: true, target: () => gate.promise })
      if (bulk) h.state.notes.two = note('two')
      const running = bulk ? h.exporter.exportAll() : h.exportOne()
      await tick()
      assert.equal(h.targets.length, 1, `应先进入原生位置选择：${action}`)
      assert.equal(h.commits.length, 0)
      const affected = bulk ? h.state.notes.two : h.state.notes.one
      if (action === 'account') h.switchAccount()
      else if (action === 'lock') { affected.readingLock = { revision: 'r1' }; h.state.lockEpoch++ }
      else affected.deleted = true
      gate.resolve({ ticket: 'delayed-ticket', path: 'D:/chosen/export' })
      await running
      assert.equal(h.commits.length + h.saves.length + h.downloads.length + h.writes.length, 0, `权限变化不能写入：${action}`)
      if (action === 'account') assert.equal(h.toasts.length, 0)
      else assert.match(h.toasts[0].message, /权限已变化/)
    }
  })
}

for (const format of ['md', 'txt', 'docx']) test(`安卓 ${format} 使用正确编码写入并分享文件`, async () => {
  const h = harness({ platform: 'android', format })
  await h.exportOne()
  assert.equal(h.writes.length, 1)
  const value = h.writes[0]
  assert.equal(value.directory, 'CACHE')
  assert.match(value.path, new RegExp(`\\.${format}$`))
  if (format === 'docx') {
    assert.equal('encoding' in value, false, 'Word 写入不能指定 utf8')
    assert.deepEqual([...Buffer.from(value.data, 'base64')], [...binary])
  } else assert.equal(value.encoding, 'utf8')
  assert.deepEqual(plain(h.shares[0].files), ['content://export/document'])
  assert.equal(h.downloads.length, 0)
})

test('安卓旧版缺少插件明确提示升级', async () => {
  const h = harness({ platform: 'android', missingPlugins: true })
  await h.exportOne()
  assert.equal(h.writes.length + h.shares.length, 0)
  assert.match(h.toasts[0].message, /升级安卓端/)
})

test('安卓取消分享不算错误，真正分享和写入错误必须报告', async () => {
  for (const [point, message, expected] of [
    ['share', 'Share canceled', false], ['share', 'No application supports this file', true], ['write', '磁盘已满', true],
  ]) {
    const h = harness({ platform: 'android', [point]: () => { throw new Error(message) } })
    await h.exportOne()
    assert.equal(h.toasts.length > 0, expected)
    if (expected) assert.ok(h.toasts[0].message.includes(message))
  }
})

test('异步转换期间换账号、上锁或删除笔记均不得保存文档', async () => {
  for (const action of ['account', 'lock', 'delete']) {
    const gate = deferred()
    const h = harness({ platform: 'desktop', format: 'docx', word: () => gate.promise })
    const running = h.exportOne()
    await tick()
    assert.equal(h.conversions.length, 1)
    if (action === 'account') h.switchAccount()
    else if (action === 'lock') { h.state.lockEpoch++; h.state.notes.one.readingLock = { revision: 'r1' } }
    else h.state.notes.one.deleted = true
    gate.resolve(binary)
    await running
    assert.equal(h.saves.length + h.downloads.length + h.writes.length, 0)
    if (action !== 'account') assert.match(h.toasts[0].message, /权限已变化/)
  }
})

test('安卓缓存写入期间换账号不得再弹分享面板', async () => {
  const gate = deferred()
  const h = harness({ platform: 'android', write: () => gate.promise })
  const running = h.exportOne()
  await tick()
  assert.equal(h.writes.length, 1)
  h.switchAccount()
  gate.resolve()
  await running
  assert.equal(h.shares.length, 0)
  assert.equal(h.toasts.length, 0, '不能向新账号显示旧账号任务错误')
})

test('转换失败收敛为提示并释放忙碌状态，不产生未处理拒绝', async () => {
  let attempts = 0
  const h = harness({ format: 'docx', word: async () => {
    if (++attempts === 1) throw new Error('生成 Word 失败')
    return binary
  } })
  await h.exportOne()
  assert.match(h.toasts[0].message, /生成 Word 失败/)
  await h.exportOne()
  assert.equal(h.downloads.length, 1)
})

test('格式选择期间重复点击不会并发弹窗或重复生成', async () => {
  const gate = deferred()
  const h = harness({ choose: () => gate.promise })
  const first = h.exportOne()
  await h.exportOne()
  assert.equal(h.dialogs.length, 1)
  gate.resolve('md')
  await first
  assert.equal(h.downloads.length, 1)
})

test('真实弹窗状态取消、覆盖及选格式均结算原 Promise', async () => {
  const context = vm.createContext({ console })
  const dialog = load('exportDialog', context, { zustand: require('../node_modules/zustand') })
  const first = dialog.chooseExportFormat('导出', false)
  const second = dialog.chooseExportFormat('全部导出', true)
  assert.equal(await first, null)
  assert.equal(dialog.useExportDialog.getState().request.bulk, true)
  dialog.closeExportDialog('docx')
  assert.equal(await second, 'docx')
  assert.equal(dialog.useExportDialog.getState().request, null)
})

;(async () => {
  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  let passed = 0
  try {
    for (const { name, run } of tests) {
      await run()
      passed++
      console.log('PASS ' + name)
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
    console.log(`export.unit: PASS (${passed}/${tests.length})`)
  } finally { process.removeListener('unhandledRejection', onUnhandled) }
})().catch(error => { console.error(error); process.exitCode = 1 })
