/** 回归：保存响应未返回时 A→B→A，再继续写 A，前一轮文字不能丢。 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootEnv, shutdown } from './harness.mjs'
import { reattach, sleep, until } from './cdp.mjs'
import * as ui from './app.mjs'

const tmp = join(tmpdir(), `cloudnote-quick-switch-${process.pid}`)
let dev
try {
  const env = await bootEnv({ tmpDir: tmp, browsers: 1 })
  await env.register('quick-switch@test.local', 'test123456', '切换测试')
  dev = await env.device('A')
  await ui.login(dev, 'quick-switch@test.local', 'test123456')
  await dev.reload()
  await sleep(3000)
  dev = await reattach(dev, { urlPart: '5273', name: '设备A' })
  await ui.waitReady(dev)

  await ui.newNote(dev)
  await sleep(1200)
  await ui.renameViaSidebar(dev, '笔记 A')
  await ui.waitSynced(dev)
  await ui.newNote(dev)
  await sleep(1200)
  await ui.renameViaSidebar(dev, '笔记 B')
  await ui.waitSynced(dev)

  const open = (name) => dev.evaluate((title) => {
    const row = [...document.querySelectorAll('.tree-label')].find((e) => e.textContent?.includes(title))
    if (!row) throw new Error(`找不到 ${title}`)
    ;(row.closest('[class*=row]') || row.parentElement).click()
  }, name)
  await open('笔记 A')
  await sleep(150)

  // 让第一笔 PATCH 真正写到服务端，但把成功响应扣住。
  await dev.evaluate(() => {
    const original = window.fetch.bind(window)
    window.__quickGate = { intercepted: false, serverReturned: false }
    window.fetch = async (...args) => {
      const [url, options] = args
      if (!window.__quickGate.intercepted && options?.method === 'PATCH' &&
          String(url).includes('/api/notes/')) {
        window.__quickGate.intercepted = true
        const response = await original(...args)
        window.__quickGate.serverReturned = true
        await new Promise((resolve) => { window.__releaseQuickGate = resolve })
        return response
      }
      return original(...args)
    }
  })

  await ui.focusBody(dev)
  await dev.type('[第一轮内容]')
  await until(() => dev.evaluate(() => window.__quickGate.serverReturned), {
    what: '第一轮保存已到服务端，响应被拦住',
  })
  const serverAfterFirst = await ui.serverNotes(dev)
  assert.ok(serverAfterFirst.some((n) => n.title === '笔记 A' && n.text.includes('[第一轮内容]')),
    '第一轮请求应已真正写入服务端')
  await open('笔记 B')
  await sleep(100)
  await open('笔记 A')
  await sleep(100)
  const bodyAfterReturn = await ui.body(dev)
  assert.ok(bodyAfterReturn.includes('[第一轮内容]'), '切回 A 时必须显示第一轮未收到回执的正文')
  await ui.focusBody(dev)
  await dev.type('[第二轮内容]')
  await dev.evaluate(() => window.__releaseQuickGate())
  await until(async () => {
    const all = await ui.serverNotes(dev)
    return all.some((n) => n.title === '笔记 A' && n.text.includes('[第二轮内容]'))
  }, { what: '第二轮内容同步至服务端' })
  await ui.waitSynced(dev)
  const serverFinal = await ui.serverNotes(dev)
  const localFinal = await ui.notes(dev)
  console.log(JSON.stringify({ bodyAfterReturn, serverAfterFirst, serverFinal, localFinal }, null, 2))
  const savedA = serverFinal.find((n) => n.title === '笔记 A')
  const cachedA = localFinal.find((n) => n.title === '笔记 A')
  assert.ok(savedA?.text.includes('[第一轮内容]') && savedA.text.includes('[第二轮内容]'),
    '服务端必须保留两轮内容')
  assert.ok(cachedA?.text.includes('[第一轮内容]') && cachedA.text.includes('[第二轮内容]'),
    '本地缓存必须保留两轮内容')
  console.log('PASS: 快速切换后两轮内容均保留。')
} finally {
  dev?.close()
  await shutdown()
}
