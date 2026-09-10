/**
 * 用 CDP 驱动一个真实浏览器窗口。
 *
 * 为什么不用 Playwright/Puppeteer：这个仓库到现在零测试依赖，服务端那份 e2e 也是
 * 裸 node 脚本。Node 22 起 WebSocket 是内置的，CDP 本身就是 WebSocket + JSON，
 * 自己写一层比装一套框架划算。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { sleep }

/** 轮询等条件成立，比写死 sleep 稳得多 */
export async function until(fn, { timeout = 15000, interval = 200, what = '条件' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await sleep(interval)
  }
}

async function pickPage(port, urlPart) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page' && t.url.includes(urlPart))
  if (!page) throw new Error(`端口 ${port} 上找不到 ${urlPart} 的页面`)
  return page
}

/**
 * 连上一个页面。名字只用于报错和日志，方便一眼看出是哪一「台设备」。
 */
export async function attach(port, { urlPart, name }) {
  const page = await pickPage(port, urlPart)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error(`${name} CDP 连接失败`)), { once: true })
  })

  let seq = 0
  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = ++seq
      const on = (e) => {
        const m = JSON.parse(e.data)
        if (m.id !== id) return
        ws.removeEventListener('message', on)
        if (m.error) rej(new Error(`${name} ${method}: ${m.error.message}`))
        else res(m.result)
      }
      ws.addEventListener('message', on)
      ws.send(JSON.stringify({ id, method, params }))
    })

  /**
   * 在页面里求值。
   *
   * fn 是一个真正的函数，序列化后在页面里执行——比拼字符串安全得多：
   * 拼字符串时 '\n' 这种会被 node 先解析成真换行再送进去，直接语法错误（踩过）。
   * 每次都套一层 IIFE，避免 const 在全局重复声明（也踩过）。
   */
  const evaluate = async (fn, ...args) => {
    const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`${name} 页面里出错：${d.exception?.description || d.text}`)
    }
    return r.result.value
  }

  const dev = {
    name,
    port,
    close: () => ws.close(),
    evaluate,
    send,

    /** 真实键盘输入，和用户敲字走同一条路径 */
    type: (text) => send('Input.insertText', { text }),

    /** 断网/恢复。CDP 层面断，WebSocket 和 fetch 一起断，和拔网线最接近 */
    offline: async (on) => {
      await send('Network.enable', {})
      await send('Network.emulateNetworkConditions', {
        offline: on,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
    },

    /** 给所有请求加延迟，把本地 0ms RTT 掩盖掉的竞态窗口撑开 */
    slowNetwork: async (latencyMs) => {
      await send('Network.enable', {})
      await send('Network.emulateNetworkConditions', {
        offline: false,
        latency: latencyMs,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
    },

    /**
     * 让符合条件的请求失败若干次，然后自动放行。
     *
     * 有些 bug 只在「某个请求恰好失败」时才发作——比如归档失败却照样收下了
     * 远端版本号。光靠断网模拟不出来：断网是全断，恢复后又全通，
     * 撞不上「网通着但这一个请求挂了」这种局面。
     *
     * 返回一个撤销函数。注意 Fetch 域一旦打开，**每个**请求都必须显式放行，
     * 漏一个页面就卡住不动了。
     */
    failRequests: async ({ method, urlIncludes, times = 1 }) => {
      await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
      let left = times
      const onPaused = (e) => {
        const m = JSON.parse(e.data)
        if (m.method !== 'Fetch.requestPaused') return
        const { requestId, request } = m.params
        const hit = left > 0 && request.method === method && request.url.includes(urlIncludes)
        if (hit) {
          left--
          send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {})
        } else {
          send('Fetch.continueRequest', { requestId }).catch(() => {})
        }
      }
      ws.addEventListener('message', onPaused)
      return async () => {
        ws.removeEventListener('message', onPaused)
        await send('Fetch.disable', {}).catch(() => {})
      }
    },

    reload: async () => {
      await evaluate(() => {
        location.reload()
        return 1
      }).catch(() => {})
    },
  }
  return dev
}

/** 页面重载后 execution context 变了，得重新 attach */
export async function reattach(dev, opts) {
  dev.close()
  await sleep(300)
  return attach(dev.port, opts)
}
