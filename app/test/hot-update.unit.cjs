// 执行真实热更新代码，文件系统与 Electron 进程生命周期使用内存替身。
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { transformSync } = require('../node_modules/esbuild')

const source = name => fs.readFileSync(path.resolve(__dirname, '../src/main/' + name + '.ts'), 'utf8')
function run(name, imports, globals = {}) {
  const code = transformSync(source(name), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const module = { exports: {} }
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {
    console, Buffer, __dirname: '/bundled/out/main', ...globals,
  }, { filename: name + '.ts' })(name => {
    if (!(name in imports)) throw new Error('Unexpected import: ' + name)
    return imports[name]
  }, module, module.exports)
  return module.exports
}

function hotHarness() {
  const files = new Map()
  const packages = new Map()
  const alive = new Set()
  const process = { pid: 100, versions: { electron: '33.4.11' }, kill(pid) {
    if (!alive.has(pid)) throw new Error('No such process')
  } }
  const dir = '/userdata/updates'
  const marker = dir + '/booting.json'
  const settings = '/userdata/settings.json'
  const memoryFs = {
    existsSync: file => files.has(file),
    mkdirSync() {},
    readdirSync: directory => [...files.keys()].filter(file => path.posix.dirname(file) === directory).map(file => path.posix.basename(file)),
    readFileSync: file => {
      if (!files.has(file)) throw new Error('ENOENT')
      return files.get(file)
    },
    writeFileSync: (file, body) => files.set(file, body),
    renameSync: (from, to) => {
      if (!files.has(from)) throw new Error('ENOENT')
      files.set(to, files.get(from)); files.delete(from)
    },
    rmSync: file => files.delete(file),
  }
  const api = run('hot', {
    electron: { app: { getPath: () => '/userdata' } },
    'node:path': path.posix,
    'node:fs': memoryFs,
    './asar': { withoutAsar: fn => fn(), readAsarFile: file => packages.get(file) ?? null },
  }, { process })
  const add = (version = '1.2.9', electron = '33') => {
    const file = `${dir}/${version}.asar`
    files.set(file, 'asar')
    packages.set(file, Buffer.from(JSON.stringify({ version, main: './out/main/index.js', cloudnote: { electron } })))
    return file
  }
  return { ...api, files, alive, process, marker, settings, add }
}

function loaderHarness({ primary = true, hot = true, loadFails = false } = {}) {
  const calls = []
  const app = {
    isPackaged: true,
    requestSingleInstanceLock: () => { calls.push('lock'); return primary },
    quit: () => calls.push('quit'),
    relaunch: () => calls.push('relaunch'),
    exit: code => calls.push('exit:' + code),
  }
  const hotFile = '/userdata/updates/1.2.9.asar'
  const imports = {
    electron: { app }, 'node:path': path.posix,
    'node:fs': { readFileSync: () => JSON.stringify({ version: '1.2.7' }) },
    './hot': {
      pickHotPackage: () => { calls.push('pick'); return hot ? { file: hotFile, version: '1.2.9', main: './out/main/index.js' } : null },
      markBooting: () => calls.push('mark'),
    },
    [path.posix.join(hotFile, './out/main/index.js')]: undefined,
    '/bundled/out/main/index.js': undefined,
  }
  // 动态 require 是 loader 的真实入口选择，记录它的调用和加载失败回退。
  const code = transformSync(source('loader'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const module = { exports: {} }
  const process = { env: {} }
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {
    console: { log() {}, error() {} }, __dirname: '/bundled/out/main', process,
  })(name => {
    if (name.endsWith('/index.js')) {
      calls.push('require:' + name)
      if (loadFails && name.startsWith(hotFile)) throw new Error('Hot package crashed')
      return {}
    }
    if (!(name in imports)) throw new Error('Unexpected import: ' + name)
    return imports[name]
  }, module, module.exports)
  return { calls, process, hotFile }
}

// 执行真实 index 的锁分支，避免启动窗口和其他不相关 IPC。
function runIndexLock(h, { alreadyHeld = false, canAcquire = false, hot = true } = {}) {
  const start = source('index').indexOf('const isPrimaryInstance =')
  const end = source('index').indexOf('app.whenReady()', start)
  assert.ok(start >= 0 && end > start, '找不到主进程单实例锁分支')
  const calls = []
  vm.runInNewContext(source('index').slice(start, end), {
    app: {
      hasSingleInstanceLock: () => alreadyHeld,
      requestSingleInstanceLock: () => { calls.push('lock'); return canAcquire },
      quit: () => calls.push('quit'),
      on: event => calls.push(event),
    },
    hotAsar: hot ? '/userdata/updates/1.2.9.asar' : null,
    clearBooting: h.clearBooting,
    showWindow() {},
  })
  return calls
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('第二实例在 loader 无锁时退出，不选择热包、不写标记、不加载入口', () => {
  const h = loaderHarness({ primary: false })
  assert.deepEqual(h.calls, ['lock', 'quit'])
  assert.equal(h.process.env.CLOUDNOTE_HOT_ASAR, undefined)
})

test('主实例先拿锁，再选择、标记和加载热更新入口', () => {
  const h = loaderHarness()
  assert.deepEqual(h.calls, ['lock', 'pick', 'mark', 'require:' + h.hotFile + '/out/main/index.js'])
  assert.equal(h.process.env.CLOUDNOTE_HOT_ASAR, h.hotFile)
})

test('没有热包时加载自带入口，热包入口失败则重启交给隔离逻辑回退', () => {
  assert.deepEqual(loaderHarness({ hot: false }).calls, ['lock', 'pick', 'require:/bundled/out/main/index.js'])
  const h = loaderHarness({ loadFails: true })
  assert.deepEqual(h.calls.slice(-2), ['relaunch', 'exit:1'])
})

test('首帧只清当前进程标记，不清其他实例或缺少 PID 的标记', () => {
  const h = hotHarness()
  const file = h.add()
  h.markBooting(file)
  h.clearBooting()
  assert.equal(h.files.has(h.marker), false)
  for (const marker of [{ file, pid: 200 }, { file }]) {
    h.files.set(h.marker, JSON.stringify(marker))
    h.clearBooting()
    assert.equal(h.files.get(h.marker), JSON.stringify(marker))
  }
})

test('坏标记和无法读取的标记不会阻断首帧', () => {
  const h = hotHarness()
  h.files.set(h.marker, '{broken')
  assert.doesNotThrow(() => h.clearBooting())
  h.files.delete(h.marker)
  assert.doesNotThrow(() => h.clearBooting())
})

test('旧 loader 的第二实例被 index 拒锁后清理自己的标记，健康包下次仍可选', () => {
  const h = hotHarness()
  const file = h.add()
  h.markBooting(file)
  h.clearBooting()
  h.process.pid = 200
  h.markBooting(file)
  assert.deepEqual(runIndexLock(h), ['lock', 'quit'])
  assert.equal(h.files.has(h.marker), false)
  h.process.pid = 300
  assert.equal(h.pickHotPackage('1.2.7', () => {}).file, file)
  assert.equal(h.files.has(h.settings), false)
})

test('index 复用新 loader 持有的锁，不重复申请', () => {
  const h = hotHarness()
  assert.deepEqual(runIndexLock(h, { alreadyHeld: true }), ['second-instance'])
})

test('旧 loader 被拒锁时不会删除另一个实例的启动标记', () => {
  const h = hotHarness()
  h.markBooting(h.add())
  const marker = h.files.get(h.marker)
  h.process.pid = 200
  runIndexLock(h)
  assert.equal(h.files.get(h.marker), marker)
})

test('真实启动失败的热包仍被隔离并加入拒绝名单', () => {
  const h = hotHarness()
  const file = h.add()
  h.markBooting(file)
  h.process.pid = 200
  assert.equal(h.pickHotPackage('1.2.7', () => {}), null)
  assert.equal(h.files.has(file), false)
  assert.equal(h.files.has(file + '.bad'), true)
  assert.deepEqual(JSON.parse(h.files.get(h.settings)).rejectedHot, ['1.2.9'])
})

test('其他实例仍活着时保留包和标记，不隔离、不拉黑', () => {
  const h = hotHarness()
  const file = h.add()
  h.markBooting(file)
  const marker = h.files.get(h.marker)
  h.alive.add(h.process.pid)
  h.process.pid = 200
  assert.equal(h.pickHotPackage('1.2.7', () => {}), null)
  assert.equal(h.files.get(h.marker), marker)
  assert.equal(h.files.has(file), true)
  assert.equal(h.files.has(h.settings), false)
})

let failed = 0
for (const { name, fn } of tests) {
  try { fn(); console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack) }
}
console.log(`${tests.length - failed}/${tests.length} passed`)
if (failed) process.exitCode = 1
