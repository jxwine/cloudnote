// 执行真实网页检测器与提示组件，网络、时钟和 React 调度使用可控替身。
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const { transformSync } = require('../node_modules/esbuild')

const PAGE_URL = 'https://notes.example/notebook/?view=compact#/note'
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function events(extra = {}) {
  const listeners = new Map()
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    dispatch: type => { for (const fn of [...(listeners.get(type) || [])]) fn() },
    listenerCount: () => [...listeners.values()].reduce((count, fns) => count + fns.size, 0),
  }
}

// 检测器只读取这三个 DOM 查询；返回确定的文档节点，不在测试里复制签名算法。
function documentFixture({ root = true, scripts = ['./assets/index-old.js'], styles = ['./assets/index-old.css'] } = {}) {
  const element = attrs => ({ getAttribute: name => attrs[name] ?? null })
  return events({
    visibilityState: 'visible',
    getElementById: id => id === 'root' && root ? {} : null,
    querySelectorAll: selector => {
      if (selector === 'script[type="module"][src]') return scripts.map(src => element({ src }))
      if (selector === 'link[rel="stylesheet"][href]') return styles.map(href => element({ href }))
      throw new Error('Unexpected DOM query: ' + selector)
    },
  })
}

function load(relative, context, imports = {}, defines = {}) {
  const filename = path.resolve(__dirname, '../src/renderer/src/' + relative)
  const code = transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: filename.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022',
    jsx: 'automatic', define: defines,
  }).code
  const module = { exports: {} }
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context, { filename })(name => {
    if (!(name in imports)) throw new Error('Unexpected import: ' + name)
    return imports[name]
  }, module, module.exports)
  return module.exports
}

function detectorHarness(options = {}) {
  let now = 1_800_000_000_000, nextTimer = 0, nextFixture = 0
  const document = documentFixture(options.current)
  const window = events()
  const navigator = { onLine: options.online !== false }
  const timers = new Map(), documents = new Map(), responses = [], requests = [], changes = []
  let aborted = 0
  if (options.hidden) document.visibilityState = 'hidden'
  const response = (fixture = {}, overrides = {}) => {
    const body = '<!doctype html><fixture id="' + ++nextFixture + '"></fixture>'
    documents.set(body, documentFixture(fixture))
    return {
      ok: true, redirected: false,
      headers: { get: name => name === 'content-type' ? 'text/html; charset=utf-8' : null },
      text: async () => body,
      ...overrides,
    }
  }
  const context = vm.createContext({
    console, URL, AbortController,
    Date: class extends Date { static now() { return now } },
    window, document, navigator, location: { href: PAGE_URL },
    DOMParser: class {
      parseFromString(html, type) {
        assert.equal(type, 'text/html')
        return documents.get(html) || documentFixture({ root: false, scripts: [], styles: [] })
      }
    },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay, interval: delay }); return id },
    clearInterval: id => timers.delete(id),
    fetch: async (url, init) => {
      requests.push({ url, init })
      const next = responses.length ? responses.shift() : response()
      if (next === 'pending') return await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')) }, { once: true })
      })
      if (next instanceof Error) throw next
      return await next
    },
  })
  const api = load('lib/webUpdate.ts', context)
  const advance = async ms => {
    const end = now + ms
    for (let count = 0; count < 100; count++) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due
      now = timer.at
      if (timer.interval) timer.at += timer.interval
      else timers.delete(id)
      timer.fn()
      await tick()
    }
    now = end
    await tick()
  }
  return {
    ...api, document, window, navigator, requests, changes, timers, response, advance,
    queue: (...items) => responses.push(...items),
    start: () => api.watchWebUpdate(build => changes.push(build)),
    aborted: () => aborted,
  }
}

function componentHarness(options = {}) {
  let cursor = 0, dirty = true, availableCallback, watchCalls = 0, cleanupCalls = 0, prepareCalls = 0
  let prepareOk = options.prepareOk !== false
  const states = [], effects = [], pendingEffects = [], navigations = []
  const navigator = { onLine: options.online !== false }
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const context = vm.createContext({
    console, URL, Date, navigator,
    location: { href: PAGE_URL, replace: url => navigations.push(url) },
  })
  const webUpdate = load('lib/webUpdate.ts', context)
  const imports = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], value => {
          const next = typeof value === 'function' ? value(states[index]) : value
          if (!Object.is(states[index], next)) { states[index] = next; dirty = true }
        }]
      },
      useEffect(fn, deps) {
        const index = cursor++
        const previous = effects[index]
        if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
          pendingEffects.push(() => {
            previous?.cleanup?.()
            effects[index] = { deps, cleanup: fn() }
          })
        }
      },
    },
    '@/lib/platform': { isDesktop: !!options.desktop, isNative: !!options.native },
    '@/lib/sync': { prepareForReload: () => { prepareCalls++; return prepareOk } },
    '@/lib/webUpdate': {
      webReloadUrl: webUpdate.webReloadUrl,
      watchWebUpdate: fn => { watchCalls++; availableCallback = fn; return () => { cleanupCalls++ } },
    },
  }
  const { WebUpdateNotice } = load('components/WebUpdateNotice.tsx', context, imports, {
    'import.meta.env.PROD': options.dev ? 'false' : 'true',
  })
  let tree
  const render = () => {
    do {
      dirty = false
      cursor = 0
      tree = WebUpdateNotice()
      for (const effect of pendingEffects.splice(0)) effect()
    } while (dirty)
    return tree
  }
  return {
    render, navigator, navigations,
    emit: build => { availableCallback?.(build); return render() },
    click: label => {
      const button = descendants(render()).find(node => node?.type === 'button' && text(node) === label)
      assert.ok(button, 'Missing button: ' + label)
      if (!button.props.disabled) button.props.onClick()
      return render()
    },
    watchCalls: () => watchCalls, cleanupCalls: () => cleanupCalls, prepareCalls: () => prepareCalls,
    setPrepareOk: value => { prepareOk = value },
    unmount: () => { for (const effect of effects) effect?.cleanup?.() },
  }
}

function descendants(node) {
  if (node == null || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap(descendants)
  if (typeof node !== 'object') return [node]
  return [node, ...descendants(node.props?.children)]
}
const text = node => descendants(node).filter(value => typeof value === 'string' || typeof value === 'number').join('')
const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('相同入口的绝对与相对资源地址、资源顺序不会误报更新', () => {
  const h = detectorHarness()
  const a = documentFixture({ scripts: ['./assets/a.js', './assets/b.js'] })
  const b = documentFixture({ scripts: ['/notebook/assets/b.js', 'https://notes.example/notebook/assets/a.js'] })
  assert.equal(h.webBuildFingerprint(a, PAGE_URL), h.webBuildFingerprint(b, PAGE_URL))
})

test('相同版本号下 JS 或仅 CSS 变化都会改变构建签名', () => {
  const h = detectorHarness()
  const current = h.webBuildFingerprint(documentFixture(), PAGE_URL)
  for (const fixture of [{ scripts: ['./assets/index-new.js'] }, { styles: ['./assets/index-new.css'] }]) {
    assert.notEqual(h.webBuildFingerprint(documentFixture(fixture), PAGE_URL), current)
  }
})

test('错误页、缺少入口、跨站脚本与开发入口均不构成有效网页构建', () => {
  const h = detectorHarness()
  for (const fixture of [
    { root: false }, { scripts: [] }, { scripts: ['https://other.example/assets/app.js'] },
    { scripts: ['/src/main.tsx'] },
  ]) assert.equal(h.webBuildFingerprint(documentFixture(fixture), PAGE_URL), null)
})

test('浏览器扩展注入的外部样式与模块不干扰网页构建检测', () => {
  const h = detectorHarness()
  const original = h.webBuildFingerprint(documentFixture(), PAGE_URL)
  const injected = documentFixture({
    scripts: ['./assets/index-old.js', 'chrome-extension://extension-id/assets/content.js'],
    styles: ['./assets/index-old.css', 'chrome-extension://extension-id/css/content-shared.css', 'https://extension.example/theme.css'],
  })
  assert.equal(h.webBuildFingerprint(injected, PAGE_URL), original)
})

test('首次检测已经是新版时立即提示，基准来自已加载页面', async () => {
  const h = detectorHarness()
  h.queue(h.response({ scripts: ['./assets/index-next.js'] }))
  const stop = h.start()
  await tick()
  assert.equal(h.changes.length, 1)
  assert.match(h.changes[0], /index-next\.js/)
  assert.equal(h.requests[0].init.cache, 'no-store')
  const url = new URL(h.requests[0].url)
  assert.equal(url.pathname, '/notebook/')
  assert.equal(url.searchParams.get('view'), 'compact')
  assert.equal(url.hash, '')
  assert.ok(url.searchParams.has('_cloudnote_check'))
  stop()
})

test('相同构建不提示，下一轮仅 CSS 改变可提示', async () => {
  const h = detectorHarness()
  h.queue(h.response(), h.response({ styles: ['./assets/index-next.css'] }))
  const stop = h.start()
  await tick()
  assert.deepEqual(h.changes, [null])
  await h.advance(60_000)
  assert.equal(h.changes.length, 2)
  assert.match(h.changes[1], /index-next\.css/)
  stop()
})

test('非成功状态、重定向、非 HTML、错误 HTML 与离线异常静默忽略', async () => {
  const h = detectorHarness()
  h.queue(
    h.response({}, { ok: false }),
    h.response({ scripts: ['./assets/new.js'] }, { redirected: true }),
    h.response({}, { headers: { get: () => 'application/json' } }),
    h.response({}, { text: async () => '<html><h1>502 Bad Gateway</h1></html>' }),
    h.response({ root: false }),
    new Error('Network offline'),
  )
  const stop = h.start()
  await tick()
  for (let i = 0; i < 5; i++) await h.advance(60_000)
  assert.equal(h.requests.length, 6)
  assert.deepEqual(h.changes, [])
  stop()
})

test('请求超时中止后下一次检查仍可发现更新', async () => {
  const h = detectorHarness()
  h.queue('pending', h.response({ scripts: ['./assets/after-timeout.js'] }))
  const stop = h.start()
  await h.advance(10_000)
  assert.equal(h.aborted(), 1)
  assert.deepEqual(h.changes, [])
  await h.advance(50_000)
  assert.equal(h.requests.length, 2)
  assert.match(h.changes[0], /after-timeout\.js/)
  stop()
})

test('离线与隐藏标签暂停请求，联网和恢复可见事件及时补查', async () => {
  const h = detectorHarness({ online: false, hidden: true })
  const stop = h.start()
  await tick()
  assert.equal(h.requests.length, 0)
  h.navigator.onLine = true
  h.window.dispatch('online')
  await tick()
  assert.equal(h.requests.length, 0)
  h.document.visibilityState = 'visible'
  h.document.dispatch('visibilitychange')
  await tick()
  assert.equal(h.requests.length, 1)
  stop()
})

test('焦点、联网、可见事件共用请求去重与短间隔节流', async () => {
  const h = detectorHarness()
  h.queue('pending')
  const stop = h.start()
  h.window.dispatch('focus')
  h.window.dispatch('online')
  h.document.dispatch('visibilitychange')
  await tick()
  assert.equal(h.requests.length, 1)
  await h.advance(10_000)
  h.window.dispatch('focus')
  h.window.dispatch('online')
  h.document.dispatch('visibilitychange')
  await tick()
  assert.equal(h.requests.length, 2)
  h.window.dispatch('focus')
  await tick()
  assert.equal(h.requests.length, 2)
  stop()
})

test('卸载时中止在途请求并移除所有定时器和事件监听', async () => {
  const h = detectorHarness()
  h.queue('pending')
  const stop = h.start()
  assert.equal(h.window.listenerCount(), 2)
  assert.equal(h.document.listenerCount(), 1)
  stop()
  await tick()
  assert.equal(h.aborted(), 1)
  assert.equal(h.window.listenerCount(), 0)
  assert.equal(h.document.listenerCount(), 0)
  assert.equal(h.timers.size, 0)
  h.window.dispatch('focus')
  await h.advance(120_000)
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.changes, [])
})

test('卸载后即使响应正文才完成也不回调已销毁组件', async () => {
  const h = detectorHarness()
  const body = deferred()
  const response = h.response({ scripts: ['./assets/late-response.js'] })
  const html = await response.text()
  h.queue({ ...response, text: () => body.promise })
  const stop = h.start()
  await tick()
  stop()
  body.resolve(html)
  await tick()
  assert.deepEqual(h.changes, [])
  assert.equal(h.timers.size, 0)
})

test('非构建页面不会注册检测事件或发送请求', async () => {
  const h = detectorHarness({ current: { scripts: ['/src/main.tsx'] } })
  h.start()()
  await tick()
  assert.equal(h.requests.length, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.window.listenerCount() + h.document.listenerCount(), 0)
})

test('组件仅在生产网页启动检测，客户端和开发环境不启动', () => {
  for (const options of [{ desktop: true }, { native: true }, { dev: true }]) {
    const h = componentHarness(options)
    assert.equal(h.render(), null)
    assert.equal(h.watchCalls(), 0)
    h.unmount()
  }
  const h = componentHarness()
  assert.equal(h.render(), null)
  assert.equal(h.watchCalls(), 1)
  h.unmount()
  assert.equal(h.cleanupCalls(), 1)
})

test('更新提示非阻断，稍后关闭同构建不重提，新构建重新提示', () => {
  const h = componentHarness()
  h.render()
  let tree = h.emit('build-2')
  assert.equal(tree.type, 'aside')
  assert.equal(tree.props['aria-label'], '网页更新提示')
  assert.ok(descendants(tree).some(node => node?.props?.['aria-live'] === 'polite'))
  assert.match(text(tree), /网页已更新/)
  assert.equal(h.click('稍后'), null)
  assert.equal(h.emit('build-2'), null)
  assert.equal(h.navigations.length, 0)
  assert.equal(h.prepareCalls(), 0)
  tree = h.emit('build-3')
  assert.match(text(tree), /立即更新/)
  h.unmount()
})

test('prepareForReload 失败显示草稿错误并阻止导航，可安全重试', () => {
  const h = componentHarness({ prepareOk: false })
  h.render()
  h.emit('new-build')
  const tree = h.click('立即更新')
  assert.match(text(tree), /草稿暂时无法安全保存/)
  assert.ok(descendants(tree).some(node => node?.props?.role === 'alert'))
  assert.equal(h.prepareCalls(), 1)
  assert.equal(h.navigations.length, 0)
  h.setPrepareOk(true)
  h.click('立即更新')
  assert.equal(h.prepareCalls(), 2)
  assert.equal(h.navigations.length, 1)
  h.unmount()
})

test('离线点击不执行保存或导航，联网后可再次更新', () => {
  const h = componentHarness({ online: false })
  h.render()
  h.emit('new-build')
  assert.match(text(h.click('立即更新')), /当前离线/)
  assert.equal(h.prepareCalls(), 0)
  assert.equal(h.navigations.length, 0)
  h.navigator.onLine = true
  h.click('立即更新')
  assert.equal(h.prepareCalls(), 1)
  assert.equal(h.navigations.length, 1)
  h.unmount()
})

test('成功更新保留路径、参数和 hash，增加防缓存参数且按钮防重复操作', () => {
  const h = componentHarness()
  h.render()
  h.emit('new-build')
  const tree = h.click('立即更新')
  assert.equal(h.prepareCalls(), 1)
  assert.equal(h.navigations.length, 1)
  const url = new URL(h.navigations[0])
  assert.equal(url.origin, 'https://notes.example')
  assert.equal(url.pathname, '/notebook/')
  assert.equal(url.searchParams.get('view'), 'compact')
  assert.equal(url.hash, '#/note')
  assert.ok(/^\d+$/.test(url.searchParams.get('_cloudnote_update')))
  assert.ok(descendants(tree).filter(node => node?.type === 'button').every(node => node.props.disabled))
  h.click('正在更新…')
  assert.equal(h.navigations.length, 1)
  h.unmount()
})

test('下次构建出现时清除旧错误，更新参数不会无限累积', () => {
  const h = componentHarness({ online: false })
  h.render()
  h.emit('build-2')
  h.click('立即更新')
  assert.match(text(h.render()), /当前离线/)
  assert.doesNotMatch(text(h.emit('build-3')), /当前离线/)
  const detector = detectorHarness()
  const url = new URL(detector.webReloadUrl('https://notes.example/?keep=1&_cloudnote_update=old#/admin'))
  assert.equal(url.searchParams.getAll('_cloudnote_update').length, 1)
  assert.equal(url.searchParams.get('keep'), '1')
  assert.equal(url.hash, '#/admin')
  h.unmount()
})

;(async () => {
  let failed = 0
  for (const { name, fn } of tests) {
    try { await fn(); console.log('PASS ' + name) }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack) }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`)
  if (failed) process.exitCode = 1
})().catch(error => { console.error(error); process.exitCode = 1 })
