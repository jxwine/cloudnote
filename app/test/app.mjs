/**
 * 把「用云笔记」这件事翻译成测试能调的动作。
 *
 * 所有选择器集中在这里，界面改了只用改这一处。
 */
import { until, sleep } from './cdp.mjs'

export const SERVER = 'http://127.0.0.1:4472'

/** 直接走 API 登录再刷新，比驱动登录表单稳（表单是受控组件，要绕原生 setter） */
export async function login(dev, email, password) {
  await dev.evaluate(
    async (server, e, p) => {
      localStorage.clear()
      const r = await fetch(server + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: e, password: p }),
      })
      if (!r.ok) throw new Error('登录失败 ' + r.status)
      const d = await r.json()
      localStorage.setItem('cloudnote.token', d.token)
      localStorage.setItem('cloudnote.user', JSON.stringify(d.user))
      localStorage.setItem('cloudnote.server', server)
      return 'ok'
    },
    SERVER,
    email,
    password
  )
}

/** 等到主界面出来、同步连上 */
export async function waitReady(dev) {
  await until(() => dev.evaluate(() => !!document.querySelector('.titlebar')), {
    what: `${dev.name} 主界面`,
  })
  await until(
    () => dev.evaluate(() => document.querySelector('.sync-chip')?.textContent?.includes('已同步')),
    { what: `${dev.name} 同步连上` }
  )
}

export const newNote = (dev) =>
  dev.evaluate(() => {
    document.querySelector('[title^="新建笔记"]').click()
    return 'ok'
  })

/**
 * 打开第 n 篇笔记。
 *
 * 按标题找会在有多篇「无标题」时选错——之前就因为这个把一次失败误判成通过。
 * 用序号，调用方自己保证顺序。
 */
export const openNoteAt = (dev, index) =>
  dev.evaluate((i) => {
    const rows = [...document.querySelectorAll('.tree-label')]
    if (!rows[i]) throw new Error(`侧栏只有 ${rows.length} 篇笔记，取不到第 ${i} 篇`)
    ;(rows[i].closest('[class*=row]') || rows[i].parentElement).click()
    return 'ok'
  }, index)

/** 把光标放到正文末尾 */
export const focusBody = (dev) =>
  dev.evaluate(() => {
    const el = document.querySelector('.ProseMirror')
    if (!el) throw new Error('编辑器还没出来')
    el.focus()
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return 'ok'
  })

export const body = (dev) =>
  dev.evaluate(() => document.querySelector('.ProseMirror')?.innerText ?? '')

export const sidebar = (dev) =>
  dev.evaluate(() => document.querySelector('.panel-left')?.innerText ?? '')

export const noticeCount = (dev) =>
  dev.evaluate(() => document.querySelectorAll('.notice').length)

/** toast 3 秒就没，装个采样器才抓得到 */
export const spyToasts = (dev) =>
  dev.evaluate(() => {
    window.__toasts = []
    if (window.__toastTimer) clearInterval(window.__toastTimer)
    window.__toastTimer = setInterval(() => {
      const e = document.querySelector('.toast')
      const t = e && e.textContent
      if (t && !window.__toasts.includes(t)) window.__toasts.push(t)
    }, 150)
    return 'ok'
  })

export const toasts = (dev) => dev.evaluate(() => window.__toasts || [])
export const clearToasts = (dev) =>
  dev.evaluate(() => {
    window.__toasts = []
    return 'ok'
  })

/** 本端看到的所有活着的笔记 */
export const notes = (dev) =>
  dev.evaluate(() => {
    // 用 DOM 取纯文本，不要正则 strip：正文里的 << >> 会被存成 &lt;&lt; &gt;&gt;，
    // 正则解不了实体，断言就永远比不上（这个坑第一次跑测试就踩了）
    const plain = (html) => {
      const d = document.createElement('div')
      d.innerHTML = html || ''
      return d.textContent || ''
    }
    const raw = localStorage.getItem('cloudnote.cache')
    if (!raw) return []
    return Object.values(JSON.parse(raw).notes || {})
      .filter((n) => !n.deleted)
      .map((n) => ({
        id: n.id,
        title: n.title || '',
        version: n.version,
        text: plain(n.content),
        isConflictCopy: !!n.conflictOf,
      }))
  })

/** 服务端上的真实数据，用来判断「客户端以为的」和「实际存下来的」是否一致 */
export async function serverNotes(dev) {
  return dev.evaluate(async (server) => {
    const t = localStorage.getItem('cloudnote.token')
    const r = await fetch(server + '/api/sync/pull?since=0', {
      headers: { Authorization: 'Bearer ' + t },
    })
    const d = await r.json()
    const plain = (html) => {
      const el = document.createElement('div')
      el.innerHTML = html || ''
      return el.textContent || ''
    }
    return (d.notes || [])
      .filter((n) => !n.deleted)
      .map((n) => ({ title: n.title || '', text: plain(n.content) }))
  }, SERVER)
}

/**
 * 等这一端把攒着的改动真的送出去。
 *
 * 不能一上来就看状态栏：保存有 700ms 防抖，刚打完字那一刻状态还是「已同步」，
 * 直接返回的话后面的步骤就建立在「以为存过了」的假象上——这套测试第一版
 * 就是栽在这儿，服务端根本没收到东西，冲突自然也就撞不出来。
 * 先跨过防抖窗口，再等状态落回已同步。
 */
export const waitSynced = async (dev, timeout = 20000) => {
  await sleep(1200)
  await until(
    () => dev.evaluate(() => document.querySelector('.sync-chip')?.textContent?.includes('已同步')),
    { timeout, what: `${dev.name} 回到已同步` }
  )
  // 状态是乐观更新的，给回执留一点时间
  await sleep(600)
}

export { sleep }

/** 把这一端发出的请求记下来，排查时序问题用 */
export const spyRequests = (dev) =>
  dev.evaluate(() => {
    window.__req = []
    if (window.__reqHooked) return 'already'
    window.__reqHooked = true
    const orig = window.fetch
    window.fetch = async (...a) => {
      const url = String(a[0])
      const method = (a[1] && a[1].method) || 'GET'
      let base = ''
      try {
        const b = a[1] && a[1].body
        if (b) base = ' base=' + JSON.parse(b).baseVersion
      } catch {}
      try {
        const r = await orig(...a)
        window.__req.push(method + ' ' + url.split('/api/')[1] + ' -> ' + r.status + base)
        return r
      } catch (e) {
        window.__req.push(method + ' ' + url.split('/api/')[1] + ' -> FAIL' + base)
        throw e
      }
    }
    return 'ok'
  })

export const requests = (dev) => dev.evaluate(() => window.__req || [])
