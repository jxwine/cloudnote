// 执行真实主进程模块；只替换 Electron 对话框，文件写入使用隔离临时目录。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { transformSync } = require('../node_modules/esbuild')

const filename = path.resolve(__dirname, '../src/main/exportTarget.ts')
const code = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudnote-export-target-'))
function harness() {
  const dir = fs.mkdtempSync(path.join(root, 'case-'))
  const sender = new EventEmitter()
  let destroyed = false
  sender.isDestroyed = () => destroyed
  const window = { webContents: sender, isDestroyed: () => destroyed }
  let currentWindow = window
  const handlers = {}, dialogs = []
  let saveResponse = { canceled: false, filePath: path.join(dir, 'chosen.docx') }
  let folderResponse = { canceled: false, filePaths: [dir] }
  const electron = {
    app: { getPath: () => dir },
    ipcMain: { handle: (name, handler) => { assert.ok(!handlers[name]); handlers[name] = handler } },
    dialog: {
      showSaveDialog: async (win, options) => { dialogs.push({ kind: 'save', win, options }); return typeof saveResponse === 'function' ? saveResponse() : saveResponse },
      showOpenDialog: async (win, options) => { dialogs.push({ kind: 'folder', win, options }); return typeof folderResponse === 'function' ? folderResponse() : folderResponse },
    },
  }
  const module = { exports: {} }
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { Buffer, Uint8Array }, { filename })(
    (name) => name === 'electron' ? electron : require(name), module, module.exports)
  module.exports.registerExportTargets(() => currentWindow)
  const event = { sender }
  return {
    dir, dialogs, event, handlers,
    choose: (name = '测试.docx', bulk = false) => handlers['export:choose-target'](event, name, bulk),
    write: (ticket, files) => handlers['export:write-target'](event, ticket, files),
    setSave: (response) => { saveResponse = response },
    setFolder: (response) => { folderResponse = response },
    removeWindow: () => { currentWindow = null },
    destroy: () => { destroyed = true; sender.emit('destroyed') },
  }
}
const tests = []
const test = (name, run) => tests.push({ name, run })
const file = (value = '中文正文', filePath = '目录/中文.txt') => ({ path: filePath, content: value })

test('选择和取消不创建任何导出文件', async () => {
  const h = harness()
  const target = await h.choose()
  assert.ok(target.ticket)
  assert.equal(target.path, path.join(h.dir, 'chosen.docx'))
  assert.deepEqual(fs.readdirSync(h.dir), [])
  h.setSave({ canceled: true })
  assert.equal(await h.choose(), null)
  assert.deepEqual(fs.readdirSync(h.dir), [])
  assert.throws(() => h.write(target.ticket, [file()]), /失效/)
  h.setFolder({ canceled: true, filePaths: [] })
  assert.equal(await h.choose('导出.docx', true), null)
  assert.deepEqual(fs.readdirSync(h.dir), [])
})

test('单篇二进制原样写入，只使用用户选中的路径，票据只能使用一次', async () => {
  const h = harness()
  const target = await h.choose()
  const bytes = new Uint8Array([0x50, 0x4b, 0, 0xff, 0x80])
  const result = h.write(target.ticket, [file(bytes, '../ignored-path.docx')])
  assert.equal(result.ok, true)
  assert.equal(result.path, target.path)
  assert.deepEqual(fs.readFileSync(target.path), Buffer.from(bytes))
  assert.throws(() => h.write(target.ticket, [file()]), /失效/)
})

test('单篇 UTF-8 中文完整且文件过滤器按格式切换', async () => {
  const h = harness()
  const target = await h.choose('中文.txt')
  assert.equal(h.dialogs[0].options.filters[0].extensions[0], 'txt')
  h.write(target.ticket, [file('\uFEFF中文\n第二行')])
  assert.equal(fs.readFileSync(target.path, 'utf8'), '\uFEFF中文\n第二行')
  await h.choose('中文.md')
  assert.equal(h.dialogs[1].options.filters[0].extensions[0], 'md')
  await h.choose('中文.DOCX')
  assert.equal(h.dialogs[2].options.filters[0].extensions[0], 'docx')
})

test('批量保留目录、二进制和 UTF-8，重复导出不会覆盖前一份', async () => {
  const h = harness()
  const first = await h.choose('云笔记导出.docx', true)
  assert.deepEqual(fs.readdirSync(h.dir), [])
  const bytes = new Uint8Array([0x50, 0x4b, 0xff, 0])
  const result = h.write(first.ticket, [file(bytes, '项目/笔记.docx'), file('正文甲', '项目/文字.txt')])
  assert.equal(result.count, 2)
  assert.deepEqual(fs.readFileSync(path.join(result.path, '项目/笔记.docx')), Buffer.from(bytes))
  assert.equal(fs.readFileSync(path.join(result.path, '项目/文字.txt'), 'utf8'), '正文甲')
  const second = await h.choose('云笔记导出.docx', true)
  const newer = h.write(second.ticket, [file('正文乙', '项目/文字.txt')])
  assert.notEqual(newer.path, result.path)
  assert.equal(fs.readFileSync(path.join(result.path, '项目/文字.txt'), 'utf8'), '正文甲')
  assert.equal(fs.readFileSync(path.join(newer.path, '项目/文字.txt'), 'utf8'), '正文乙')
})

test('各种越界和 Windows 特殊路径在落盘前拒绝', async () => {
  const h = harness()
  for (const value of ['../outside.txt', 'folder/../../outside', '/absolute.txt', '\\absolute.txt',
    'C:\\absolute.txt', 'C:drive-relative.txt', '\\\\server\\share\\x', 'folder\\..\\x',
    'folder/file.txt:stream', 'folder//x', './x', 'folder/CON.txt', 'folder/trailing. ', 'nul', 'bad\u0000name']) {
    const target = await h.choose('导出.txt', true)
    assert.throws(() => h.write(target.ticket, [file('正常文件', 'normal.txt'), file('错误文件', value)]), /路径无效/, value)
    assert.deepEqual(fs.readdirSync(h.dir), [], value + ' 不得创建导出目录')
  }
})

test('重复文件、大小写冲突以及文件与目录冲突在落盘前拒绝', async () => {
  const h = harness()
  for (const paths of [['a.txt', 'a.txt'], ['A.txt', 'a.txt'], ['a', 'a/b.txt'], ['a/b.txt', 'A']]) {
    const target = await h.choose('导出.txt', true)
    assert.throws(() => h.write(target.ticket, paths.map((p) => file('正文', p))), /重复|重名/)
    assert.deepEqual(fs.readdirSync(h.dir), [])
  }
})

test('单篇多文件或无效内容失败后票据立即失效且不落盘', async () => {
  const h = harness()
  for (const files of [[file(), file()], [], [{ path: 'x', content: { invalid: true } }]]) {
    const target = await h.choose()
    assert.throws(() => h.write(target.ticket, files), /只能|无效/)
    assert.throws(() => h.write(target.ticket, [file()]), /失效/)
    assert.deepEqual(fs.readdirSync(h.dir), [])
  }
})

test('不同 webContents 无法借用票据，也不能使合法票据失效', async () => {
  const h = harness()
  const target = await h.choose()
  const other = { sender: { isDestroyed: () => false } }
  assert.equal(await h.handlers['export:choose-target'](other, 'x.txt', false), null)
  assert.throws(() => h.handlers['export:write-target'](other, target.ticket, [file()]), /失效/)
  assert.equal(h.write(target.ticket, [file()]).ok, true)
})

test('最近一次选择使前一票据失效', async () => {
  const h = harness()
  const first = await h.choose()
  const latest = await h.choose()
  assert.notEqual(first.ticket, latest.ticket)
  assert.throws(() => h.write(first.ticket, [file()]), /失效/)
  assert.equal(h.write(latest.ticket, [file()]).ok, true)
})

test('重叠对话框仅最后一次请求能发出票据', async () => {
  const h = harness()
  let resolveFirst, resolveLatest
  h.setSave(() => new Promise((resolve) => { resolveFirst = resolve }))
  const first = h.choose()
  h.setSave(() => new Promise((resolve) => { resolveLatest = resolve }))
  const latest = h.choose()
  resolveLatest({ canceled: false, filePath: path.join(h.dir, 'latest.txt') })
  const target = await latest
  resolveFirst({ canceled: false, filePath: path.join(h.dir, 'first.txt') })
  assert.equal(await first, null)
  h.write(target.ticket, [file()])
  assert.deepEqual(fs.readdirSync(h.dir), ['latest.txt'])
})

test('没有主窗口及窗口销毁不会写入文件', async () => {
  const h = harness()
  const target = await h.choose()
  h.destroy()
  assert.equal(await h.choose(), null)
  assert.throws(() => h.write(target.ticket, [file()]), /失效/)
  assert.deepEqual(fs.readdirSync(h.dir), [])
  const other = harness()
  other.removeWindow()
  assert.equal(await other.choose(), null)
  assert.deepEqual(fs.readdirSync(other.dir), [])
})

test('对话框等待期间主窗口关闭，不发出票据也不创建文件', async () => {
  const h = harness()
  let finish
  h.setSave(() => new Promise((resolve) => { finish = resolve }))
  const choosing = h.choose()
  h.removeWindow()
  finish({ canceled: false, filePath: path.join(h.dir, 'unused.txt') })
  assert.equal(await choosing, null)
  assert.deepEqual(fs.readdirSync(h.dir), [])
})

;(async () => {
  let failed = 0
  try {
    for (const { name, run } of tests) {
      try { await run(); console.log('PASS ' + name) }
      catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack) }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`)
    if (failed) process.exitCode = 1
  } finally {
    // 只删除本次创建、且确认位于系统临时目录内的测试目录。
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true })
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
