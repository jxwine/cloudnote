/**
 * 网页版响应式回归：手机 / 平板 / 桌面三档各一遍。
 *
 * 一个真实 Chrome，用 CDP 的设备模拟把视口切成五个宽度，每档截一张图、跑一组断言。
 * 断言量的是几何（getBoundingClientRect / position），不看 class 名——
 * class 加上了但样式没生效这种事，只有量尺寸才抓得到。
 *
 * 跑：  npm --prefix app run test:responsive          （看得见窗口）
 *       npm --prefix app run test:responsive -- --headless
 * 前置：npm --prefix app run build
 * 截图落在 test/.shots/（已 gitignore）。
 */
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootEnv, shutdown } from './harness.mjs'
import { sleep, reattach } from './cdp.mjs'
import * as ui from './app.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(here, '.shots')
const TMP = join(tmpdir(), 'cloudnote-responsive', String(process.pid))
const PASSWORD = 'test123456'

/** 五个宽度：小屏手机、常见手机、平板竖屏、平板横屏 / 窄笔记本、普通笔记本 */
const SIZES = [
  { w: 320, h: 568, tier: 'phone' },
  { w: 390, h: 844, tier: 'phone' },
  { w: 768, h: 1024, tier: 'tablet' },
  { w: 1024, h: 768, tier: 'tablet' },
  { w: 1366, h: 900, tier: undefined },
]

const results = []
let env
let dev

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

let touchNow = false

/**
 * 切视口。≤1024 的按触屏设备模拟：除了尺寸，还把 hover/pointer 媒体特性改成 none/coarse——
 * 页面里的 isTouch 是加载时算一次的（真机上这个不会变），所以触屏/非触屏切换时要重载一次页面。
 */
async function setViewport({ w, h }) {
  const mobile = w <= 1024
  await dev.send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile,
  })
  await dev.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
  await dev.send('Emulation.setEmulatedMedia', {
    features: mobile
      ? [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }]
      : [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }],
  })
  if (mobile !== touchNow) {
    touchNow = mobile
    await dev.reload()
    await sleep(1500)
    dev = await reattach(dev, { urlPart: '5273', name: '设备A' })
    await ui.waitReady(dev)
  }
  // matchMedia 的 change 是异步派发的，给 React 一帧
  await sleep(400)
}

/** 真实按键。Input.insertText 塞不出回车，标题的 Markdown 输入规则也要靠真实输入触发 */
async function press(key, code, vk) {
  await dev.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : undefined,
  })
  await dev.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
}
const enter = () => press('Enter', 'Enter', 13)

async function shot(name) {
  const { data } = await dev.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
}

/** 页面里量几何的小工具，每次都整份传进去，免得在页面全局留东西 */
const measure = (dev) =>
  dev.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height,
        position: cs.position, opacity: cs.opacity, display: cs.display,
      }
    }
    return {
      viewport: document.documentElement.dataset.viewport ?? null,
      touch: 'touch' in document.documentElement.dataset,
      innerWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      left: r('.panel-left'),
      right: r('.panel-right'),
      editor: r('.editor-pane'),
      backdrop: r('.drawer-backdrop'),
      resizers: document.querySelectorAll('.resizer').length,
      bar: (() => {
        const el = document.querySelector('.editor-bar')
        return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null
      })(),
      treeActions: r('.tree-actions'),
      titlebarOverflow: [...document.querySelectorAll('.titlebar > *')].some(
        (el) => el.getBoundingClientRect().right > innerWidth + 0.5
      ),
      findBtn: !!document.querySelector('.editor-bar [title^="查找替换"]'),
      download: !!document.querySelector('.titlebar .dl-group'),
    }
  })

const click = (sel) =>
  dev.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) throw new Error('找不到 ' + s)
    el.click()
    return 'ok'
  }, sel)

async function run() {
  rmSync(SHOTS, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  env = await bootEnv({ tmpDir: TMP, browsers: 1 })

  const email = 'responsive@test.local'
  await env.register(email, PASSWORD, '响应式')
  let d = await env.device('A')
  await ui.login(d, email, PASSWORD)
  await d.reload()
  await sleep(2500)
  dev = await reattach(d, { urlPart: '5273', name: '设备A' })
  await ui.waitReady(dev)

  // 先在桌面档造点内容：两篇笔记，第二篇带几个标题给大纲用。
  // 标题直接敲在标题框里（新建后它自动聚焦），别让正文的 # 标题被结算成笔记标题——
  // 那条路上有个和本次无关的老问题：刷新页面会多出一份冲突副本
  await ui.newNote(dev)
  await sleep(600)
  await dev.type('第一篇')
  await ui.focusBody(dev)
  await dev.type('第一篇的正文，里面有一个链接 https://example.com 用来试触屏点击。')
  await ui.waitSynced(dev)
  await ui.newNote(dev)
  await sleep(600)
  await dev.type('第二篇')
  await ui.focusBody(dev)
  await dev.type('# ')
  await dev.type('一级标题')
  await enter()
  await dev.type('正文一段。')
  await enter()
  await dev.type('## ')
  await dev.type('二级标题')
  await enter()
  await dev.type('再来一段正文，够长一点，让大纲有东西可以点。')
  // 等保存落库再切档：切档要重载页面，带着没发出去的改动重载会走冲突副本那条路，把树搞脏
  await ui.waitSynced(dev)
  const headings = await dev.evaluate(() => document.querySelectorAll('.ProseMirror h1, .ProseMirror h2').length)
  check('造数据：第二篇有两个标题', headings === 2, `headings=${headings}`)

  for (const size of SIZES) {
    const label = `${size.w}x${size.h}`
    console.log(`\n== ${label} (${size.tier ?? 'desktop'})`)
    await setViewport(size)
    await shot(`${label}-0-initial`)
    let m = await measure(dev)

    check(`${label} 档位属性`, m.viewport === (size.tier ?? null), `data-viewport=${m.viewport}`)
    check(`${label} 无横向溢出`, m.scrollWidth <= m.innerWidth, `${m.scrollWidth} <= ${m.innerWidth}`)
    check(`${label} 顶栏按钮都在屏内`, !m.titlebarOverflow)

    if (size.tier === 'phone') {
      const rect = (sel) => dev.evaluate((s) => {
        const el = document.querySelector(s)
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }
      }, sel)
      const count = (sel) => dev.evaluate((s) => document.querySelectorAll(s).length, sel)
      const text = (sel) => dev.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel)

      check(`${label} 是手机外壳（无桌面顶栏）`, (await count('.m-home')) === 1 && (await count('.titlebar')) === 0)
      const cards0 = await count('.m-card')
      check(`${label} 首页有卡片`, cards0 >= 2, `cards=${cards0}`)
      const fab = await rect('.m-fab')
      check(`${label} ⊕ 在右下角屏内`, fab && fab.right <= size.w && fab.bottom <= size.h && fab.left > size.w / 2 && fab.top > size.h / 2, JSON.stringify(fab))
      const cardW = await rect('.m-card')
      check(`${label} 卡片两列`, cardW && cardW.width < size.w / 2 && cardW.width > size.w / 3, `width=${cardW?.width}`)

      // 点卡片 → 编辑页
      await click('.m-card')
      await sleep(600)
      const hash = await dev.evaluate(() => location.hash)
      check(`${label} 点卡片进编辑页`, hash === '#/note' && (await count('.m-note')) === 1, `hash=${hash}`)
      const bar = await rect('.editor-bar')
      check(`${label} 工具栏贴底`, bar && Math.abs(bar.bottom - size.h) < 1.5, JSON.stringify(bar))
      const title = await rect('.note-title')
      check(`${label} 标题在编辑页顶部可见`, title && title.top > 40 && title.top < 200, JSON.stringify(title))
      await shot(`${label}-1-note`)

      // 查找条
      await click('.editor-bar [title^="查找替换"]')
      await sleep(400)
      const fb = await rect('.findbar')
      check(`${label} 查找条在视口内`, fb && fb.left >= 0 && fb.right <= size.w + 0.5, JSON.stringify(fb))
      await dev.evaluate(() => { document.querySelector('.findbar [title^="关闭"]')?.click(); return 'ok' })
      await sleep(200)

      // 返回首页
      await dev.evaluate(() => { history.back(); return 'ok' })
      await sleep(500)
      check(`${label} 返回键回首页`, (await count('.m-home')) === 1 && (await dev.evaluate(() => location.hash)) === '')

      // 目录面板
      await click('.m-top [aria-label="目录"]')
      await sleep(400)
      const sheetText = await text('.m-sheet')
      await shot(`${label}-2-sheet`)
      check(`${label} 目录面板列出所有笔记/标签/回收站`, sheetText && ['所有笔记', '标签', '回收站'].every((t) => sheetText.includes(t)) && (await count('.m-sheet [aria-label="新建目录"]')) === 1, sheetText?.slice(0, 80))
      const sheet = await rect('.m-sheet')
      check(`${label} 面板贴底不溢出`, sheet && Math.abs(sheet.bottom - size.h) < 1 && sheet.left === 0 && sheet.right === size.w, JSON.stringify(sheet))
      // 进回收站再返回
      await dev.evaluate(() => { [...document.querySelectorAll('.m-sheet-row')].find((r) => r.textContent.includes('回收站')).click(); return 'ok' })
      await sleep(400)
      check(`${label} 回收站视图`, (await text('.m-title'))?.includes('回收站') && (await count('.m-fab')) === 0)
      await click('.m-top [aria-label="返回"]')
      await sleep(300)
      check(`${label} 返回笔记视图`, (await text('.m-title')) === '所有笔记')

      // 目录：新建 → 进目录 → 在目录里新建笔记 → 返回时还得在目录里
      await click('.m-top [aria-label="目录"]')
      await sleep(300)
      await click('.m-sheet [aria-label="新建目录"]')
      await sleep(500)
      const folderName = `目录${size.w}`
      const promptOk = await dev.evaluate((name) => {
        const input = document.querySelector('.dialog input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, name)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.closest('form').requestSubmit()
        return true
      }, folderName)
      await sleep(600)
      check(`${label} 新建目录弹出重命名框`, promptOk)
      await dev.evaluate((name) => { [...document.querySelectorAll('.m-sheet-main')].find((r) => r.textContent.includes(name)).click(); return 'ok' }, folderName)
      await sleep(400)
      check(`${label} 进入目录`, (await text('.m-title')) === folderName, await text('.m-title'))
      await click('.m-fab')
      await sleep(800)
      await dev.type('目录里的笔记')
      await ui.waitSynced(dev)
      await click('.m-top [aria-label="返回"]')
      await sleep(500)
      check(`${label} 从笔记返回后还在目录里`, (await text('.m-title')) === folderName && (await count('.m-card')) === 1, `title=${await text('.m-title')} cards=${await count('.m-card')}`)
      await click('.m-top [aria-label="返回"]')
      await sleep(300)
      check(`${label} 再返回到所有笔记`, (await text('.m-title')) === '所有笔记')

      // 搜索
      await dev.evaluate(() => {
        const input = document.querySelector('.m-search input')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, '二级')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'ok'
      })
      await sleep(400)
      check(`${label} 搜索出结果`, (await count('.m-list .hit')) >= 1)
      await click('.m-list .hit')
      await sleep(600)
      check(`${label} 点搜索结果进编辑页`, (await count('.m-note')) === 1)
      // 大纲面板（第二篇有两个标题）
      await click('.m-top [aria-label="大纲"]')
      await sleep(400)
      const items = await count('.m-sheet .outline-item')
      await shot(`${label}-3-outline`)
      check(`${label} 大纲面板有两条`, items === 2, `items=${items}`)
      await click('.m-sheet .outline-item')
      await sleep(300)
      check(`${label} 点大纲项后面板关闭`, (await count('.m-sheet')) === 0)
      await dev.evaluate(() => { history.back(); return 'ok' })
      await sleep(500)
      await dev.evaluate(() => { document.querySelector('.m-search-clear')?.click(); return 'ok' })
      await sleep(300)

      // ⊕ 新建
      const cardsBefore = await count('.m-card')
      await click('.m-fab')
      await sleep(800)
      check(`${label} ⊕ 进入新笔记编辑页`, (await count('.m-note')) === 1)
      const focused = await dev.evaluate(() => document.activeElement?.className ?? '')
      check(`${label} 新笔记聚焦标题`, focused.includes('note-title'), `focus=${focused}`)
      await dev.type(`手机新建 ${size.w}`)
      await ui.waitSynced(dev)
      // ··· 菜单 → 删除，回首页后卡片数不变
      await click('.m-top [aria-label="更多"]')
      await sleep(300)
      await dev.evaluate(() => { [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('删除笔记')).click(); return 'ok' })
      await sleep(800)
      const cards1 = await count('.m-card')
      check(`${label} 删除后回首页且卡片数复原`, (await count('.m-home')) === 1 && cards1 === cardsBefore, `cards=${cards1} (was ${cardsBefore})`)
      await shot(`${label}-4-home-after`)

      // 设置弹窗
      await click('.m-top [aria-label="设置"]')
      await sleep(400)
      const dlg = await dev.evaluate(() => {
        const el = document.querySelector('.dialog.settings')
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { left: b.left, right: b.right, bottom: b.bottom, hasShortcuts: !![...el.querySelectorAll('.settings-nav-item')].find((n) => n.textContent.includes('快捷键')) }
      })
      await shot(`${label}-5-settings`)
      check(`${label} 设置弹窗在视口内`, dlg && dlg.left >= 0 && dlg.right <= size.w + 0.5 && dlg.bottom <= size.h + 0.5, JSON.stringify(dlg))
      check(`${label} 触屏不显示快捷键页`, dlg && !dlg.hasShortcuts)
      await dev.evaluate(() => { document.querySelector('.dialog.settings .icon-btn')?.click(); return 'ok' })
      await sleep(300)
    } else if (size.tier === 'tablet') {
      check(`${label} 目录树留在原位`, m.left && m.left.position !== 'fixed' && m.left.left === 0 && m.left.width > 0, JSON.stringify(m.left))
      check(`${label} 目录树收窄到 ≤220`, m.left && m.left.width <= 220, `width=${m.left?.width}`)
      check(`${label} 大纲是 fixed 抽屉且收起`, m.right?.position === 'fixed' && m.right.left >= m.innerWidth - 0.5, JSON.stringify(m.right))
      check(`${label} 只有左侧拖拽手柄`, m.resizers === 1, `resizers=${m.resizers}`)
      check(`${label} 编辑区 ≥ 400`, m.editor && m.editor.width >= 400, `width=${m.editor?.width}`)
      check(`${label} 顶栏保留下载按钮`, m.download)

      await click('.titlebar [title^="大纲栏"]')
      await sleep(400)
      m = await measure(dev)
      await shot(`${label}-1-outline-open`)
      check(`${label} 大纲抽屉滑入`, m.right && Math.abs(m.right.right - m.innerWidth) < 0.5 && !!m.backdrop, `right=${m.right?.right}`)
      await click('.drawer-backdrop')
      await sleep(400)
      m = await measure(dev)
      check(`${label} 点遮罩关大纲`, m.right && m.right.left >= m.innerWidth - 0.5 && !m.backdrop)
    } else {
      check(`${label} 两个拖拽手柄`, m.resizers === 2, `resizers=${m.resizers}`)
      check(`${label} 目录树 248 宽`, m.left && Math.abs(m.left.width - 248) < 1, `width=${m.left?.width}`)
      check(`${label} 大纲 232 宽在原位`, m.right && Math.abs(m.right.width - 232) < 1 && m.right.position !== 'fixed', JSON.stringify(m.right))
      check(`${label} 没有遮罩`, !m.backdrop)
    }
  }

  // 档位来回切：手机开着抽屉 → 拖到桌面 → 抽屉状态要清掉，不能留遮罩
  console.log('\n== 档位切换')
  await setViewport(SIZES[1])
  await click('.m-card')
  await sleep(500)
  await setViewport(SIZES[4])
  let m = await measure(dev)
  const onDesktop = await dev.evaluate(() => ({ titlebar: !!document.querySelector('.titlebar'), mobile: !!document.querySelector('.m-app'), hash: location.hash }))
  check('手机编辑页切到桌面：三栏恢复、手机外壳卸载', onDesktop.titlebar && !onDesktop.mobile && m.resizers === 2, JSON.stringify(onDesktop))
  await setViewport(SIZES[1])
  const backToPhone = await dev.evaluate(() => ({ note: !!document.querySelector('.m-note'), hash: location.hash }))
  check('再切回手机：还在编辑页（hash 没丢）', backToPhone.note && backToPhone.hash === '#/note', JSON.stringify(backToPhone))
  await dev.evaluate(() => { history.back(); return 'ok' })
  await sleep(400)
}

run()
  .catch((e) => {
    console.error('\n跑挂了：', e)
    results.push({ name: '脚本本身', ok: false, detail: String(e) })
  })
  .finally(async () => {
    await shutdown()
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} 通过；截图在 ${SHOTS}`)
    if (failed.length) {
      console.log('失败：')
      for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`)
    }
    setTimeout(() => process.exit(failed.length ? 1 : 0), 500)
  })
