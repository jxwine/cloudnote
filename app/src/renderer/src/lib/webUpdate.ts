/** 网页直接比较入口资源，不依赖客户端版本号；同版本重新部署也能被发现。 */
export function webBuildFingerprint(doc: Document, pageUrl: string): string | null {
  if (!doc.getElementById('root')) return null
  const page = new URL(pageUrl)
  const assetUrl = (el: Element, attribute: string, extension: string) => {
    try {
      const url = new URL(el.getAttribute(attribute) || '', page)
      // 浏览器扩展会给当前 DOM 注入样式；只比较本站构建资源，避免扩展使检测失效。
      if (url.origin !== page.origin || !url.pathname.includes('/assets/') || !url.pathname.endsWith(extension)) return null
      return url.pathname + url.search
    } catch {
      return null
    }
  }
  const scripts = [...doc.querySelectorAll('script[type="module"][src]')]
    .map((el) => assetUrl(el, 'src', '.js')).filter((url): url is string => url !== null)
  if (!scripts.length) return null
  const styles = [...doc.querySelectorAll('link[rel="stylesheet"][href]')]
    .map((el) => assetUrl(el, 'href', '.css')).filter((url): url is string => url !== null)
  return JSON.stringify([...scripts, ...styles].sort())
}

/** 保留路径、已有参数和路由；额外参数避免普通刷新仍命中旧入口缓存。 */
export function webReloadUrl(pageUrl: string): string {
  const url = new URL(pageUrl)
  url.searchParams.set('_cloudnote_update', String(Date.now()))
  return url.href
}

/** 仅由生产网页启动。后台标签暂停检查，恢复可见/联网时及时补查。 */
export function watchWebUpdate(onChange: (build: string | null) => void): () => void {
  // 必须从已加载的页面取基准，不能把服务器第一次返回的新版误当成当前版本。
  const current = webBuildFingerprint(document, location.href)
  if (!current) return () => {}
  let alive = true
  let request: AbortController | null = null
  let lastCheck = -Infinity
  const check = async () => {
    if (!alive || request || document.visibilityState === 'hidden' || !navigator.onLine) return
    if (Date.now() - lastCheck < 10_000) return
    lastCheck = Date.now()
    const controller = new AbortController()
    request = controller
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const url = new URL(location.href)
      url.hash = ''
      url.searchParams.set('_cloudnote_check', String(Date.now()))
      const response = await fetch(url.href, { cache: 'no-store', signal: controller.signal })
      if (!response.ok || response.redirected || !response.headers.get('content-type')?.includes('text/html')) return
      const html = await response.text()
      const next = webBuildFingerprint(new DOMParser().parseFromString(html, 'text/html'), url.href)
      if (alive && next) onChange(next === current ? null : next)
    } catch {
      // 离线、超时和部署过程中的暂时失败都不打扰用户，下次继续检查。
    } finally {
      clearTimeout(timeout)
      request = null
    }
  }
  const run = () => { void check() }
  run()
  const timer = setInterval(run, 60_000)
  window.addEventListener('focus', run)
  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', run)
  return () => {
    alive = false
    request?.abort()
    clearInterval(timer)
    window.removeEventListener('focus', run)
    window.removeEventListener('online', run)
    document.removeEventListener('visibilitychange', run)
  }
}
