// 执行实际更新选择器，验证热包优先与全量兜底，网络和桌面信息使用可控替身。
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const { transformSync } = require('../node_modules/esbuild')

const filename = path.resolve(__dirname, '../src/renderer/src/lib/update.ts')
const code = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code

function harness({ current = '1.2.7', rejectedHot = [], hot = {}, exe = {} } = {}) {
  const requests = []
  const imports = {
    './api': {
      api: { latestRelease: async (platform = 'win32') => {
        requests.push(platform)
        const response = platform === 'win32-asar' ? hot : exe
        if (response instanceof Error) throw response
        return response
      } },
      fileUrl: url => 'https://notes.example' + url,
    },
    './platform': {
      isDesktop: true, isNative: false,
      desktop: { info: async () => ({ version: current, rejectedHot }) },
    },
    './store': { useStore: {} },
  }
  const module = { exports: {} }
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {}, { filename })(name => {
    assert.ok(name in imports, 'Unexpected import: ' + name)
    return imports[name]
  }, module, module.exports)
  return { ...module.exports, requests }
}

const release = (version, platform) => ({
  version, platform, url: `/downloads/${platform}/${version}`, filename: platform === 'win32-asar' ? 'update.asar' : 'setup.exe',
  size: platform === 'win32-asar' ? 2_000_000 : 84_000_000, sha256: 'a'.repeat(64), notes: '',
})
const hot = version => release(version, 'win32-asar')
const exe = version => release(version, 'win32')
const tests = [
  ['两个通道同版时优先热包', { hot: hot('1.2.10'), exe: exe('1.2.10') }, 'hot', '1.2.10'],
  ['热包版本高于全量时仍优先热包', { hot: hot('1.3.0'), exe: exe('1.2.9') }, 'hot', '1.3.0'],
  ['只有热包也可以升级', { hot: hot('1.2.9') }, 'hot', '1.2.9'],
  ['热包落后全量时选择最新全量', { hot: hot('1.2.8'), exe: exe('1.2.9') }, 'exe', '1.2.9'],
  ['本机拒绝过该版热包时回退全量', { rejectedHot: ['1.2.9'], hot: hot('1.2.9'), exe: exe('1.2.9') }, 'exe', '1.2.9'],
  ['旧版拒绝记录不影响新版热包，1.2.10大于1.2.9', { current: '1.2.9', rejectedHot: ['1.2.9'], hot: hot('1.2.10'), exe: exe('1.2.10') }, 'hot', '1.2.10'],
  ['热通道暂时失败时全量仍可用', { hot: new Error('offline'), exe: exe('1.2.9') }, 'exe', '1.2.9'],
  ['已经运行最新热包时不会重复更新', { current: '1.2.9', hot: hot('1.2.9'), exe: exe('1.2.9') }, null],
  ['拒绝热包且无全量时不重复推送坏包', { rejectedHot: ['1.2.9'], hot: hot('1.2.9') }, null],
]

;(async () => {
  let failed = 0
  for (const [name, options, kind, version] of tests) {
    try {
      const h = harness(options)
      const result = await h.checkUpdate()
      if (kind === null) assert.equal(result, null)
      else {
        assert.equal(result.kind, kind)
        assert.equal(result.version, version)
        assert.equal(result.downloadUrl, 'https://notes.example' + result.url)
      }
      assert.deepEqual(h.requests, ['win32-asar', 'win32'])
      console.log('PASS ' + name)
    } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack) }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`)
  if (failed) process.exitCode = 1
})().catch(error => { console.error(error); process.exitCode = 1 })
