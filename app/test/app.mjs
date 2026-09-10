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

/** 把 token 换成没用的值，模拟过期 / 账号被停用（服务端一律 401） */
export const breakToken = (dev) =>
  dev.evaluate(() => {
    localStorage.setItem('cloudnote.token', 'not-a-valid-token')
    return 'ok'
  })

export const authDialogText = (dev) =>
  dev.evaluate(() => {
    const d = [...document.querySelectorAll('.dialog')].find((e) =>
      e.textContent.includes('需要重新登录')
    )
    return d ? d.textContent : ''
  })

/**
 * 改标题。直接操作编辑区顶上的标题框——它是受控组件，
 * 得走原生 setter 再派发 input，不然 React 收不到。
 */
export const renameViaSidebar = (dev, title) =>
  dev.evaluate((t) => {
    const el = document.querySelector('.note-title')
    if (!el) throw new Error('找不到标题输入框')
    // 标题框是 textarea 不是 input，拿 HTMLInputElement 的 setter 去 call 会 Illegal invocation
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, t)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('blur', { bubbles: true }))
    return 'ok'
  }, title)

/** 右键当前笔记 → 删除。走真实的右键菜单，和用户操作同一条路 */
export const deleteActiveNote = async (dev) => {
  await dev.evaluate(() => {
    const row = document.querySelector('.tree-row.is-active, [class*=row][class*=active]')
    const target = row || document.querySelector('.tree-label')?.closest('[class*=row]')
    if (!target) throw new Error('侧栏里找不到当前笔记')
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 120 }))
    return 'ok'
  })
  // 只等菜单渲染出来就够。等太久会跨过 700ms 的保存防抖，
  // 「删除吞掉还没落库的内容」这个窗口就撞不上了
  await sleep(150)
  await dev.evaluate(() => {
    const item = [...document.querySelectorAll('.menu .menu-item')].find((b) =>
      b.textContent.includes('删除笔记')
    )
    if (!item) {
      const seen = [...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent)
      throw new Error('右键菜单里没有「删除笔记」，只有：' + JSON.stringify(seen))
    }
    item.click()
    return 'ok'
  })
}

/** 回收站 → 恢复第一条 */
export const restoreFromTrash = async (dev) => {
  await dev.evaluate(() => {
    document.querySelector('[title^="回收站"]').click()
    return 'ok'
  })
  await sleep(1200)
  await dev.evaluate(() => {
    const btn = [...document.querySelectorAll('.trash-actions button')].find((b) =>
      b.textContent.includes('放回去')
    )
    if (!btn) throw new Error('回收站里没有可恢复的笔记')
    btn.click()
    return 'ok'
  })
  await sleep(1200)
  // 切回笔记列表
  await dev.evaluate(() => {
    const tab = [...document.querySelectorAll('.panel-tab')].find((b) => b.textContent.includes('笔记'))
    if (tab) tab.click()
    return 'ok'
  })
}

/**
 * 在页面里直接让某类请求返回一个真实的错误响应。
 *
 * 比 CDP 的 Fetch.fulfillRequest 靠谱：那条路在这套环境里会退化成网络失败，
 * 客户端当成离线（本来就会入队重试），根本走不到「服务端明确报错」那个分支。
 * 直接换掉 window.fetch 返回一个 500 Response，语义就准确了。
 */
export const rejectInPage = (dev, { method, urlEndsWith, status = 500, times = 1 }) =>
  dev.evaluate(
    (m, u, st, n) => {
      const orig = window.__origFetch || window.fetch
      window.__origFetch = orig
      let left = n
      window.fetch = async (...a) => {
        const url = String(a[0])
        const meth = (a[1] && a[1].method) || 'GET'
        if (left > 0 && meth === m && url.endsWith(u)) {
          left--
          return new Response('{"error":"server said no"}', {
            status: st,
            headers: { 'content-type': 'application/json' },
          })
        }
        return orig(...a)
      }
      return 'ok'
    },
    method,
    urlEndsWith,
    status,
    times
  )

export const restoreFetch = (dev) =>
  dev.evaluate(() => {
    if (window.__origFetch) window.fetch = window.__origFetch
    return 'ok'
  })
