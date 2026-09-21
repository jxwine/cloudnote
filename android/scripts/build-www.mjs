/**
 * 把网页版的构建产物变成安卓壳要的 www/。
 *
 * 先在 app/ 里构建（记得带服务器地址）：
 *   VITE_CLOUDNOTE_SERVER=https://你的域名 npm --prefix app run build
 * 再 npm --prefix android run build（本脚本 + cap sync）。
 *
 * 唯一的改动是 index.html 的 CSP：Capacitor 的原生桥是往 HTML 里内联注入一段 <script>，
 * 网页版那条 default-src 'self' 会把它拦掉，这里给 script-src 放开 'unsafe-inline'。
 * 只改安卓这一份，网页版和桌面端的 index.html 原样不动。
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../app/out/renderer')
const www = resolve(here, '../www')

if (!existsSync(join(src, 'index.html'))) {
  console.error('还没有网页构建产物，先跑：VITE_CLOUDNOTE_SERVER=https://… npm --prefix app run build')
  process.exit(1)
}

rmSync(www, { recursive: true, force: true })
cpSync(src, www, { recursive: true })

const html = join(www, 'index.html')
let text = readFileSync(html, 'utf8')
const before = text
text = text.replace(/default-src 'self';/, "default-src 'self'; script-src 'self' 'unsafe-inline';")
if (text === before) {
  console.error('index.html 里没找到预期的 CSP，去看看 app/src/renderer/index.html 是不是改了')
  process.exit(1)
}
writeFileSync(html, text)

// 安卓包里不需要 PWA 的 manifest 和 iOS 图标，留着也无害，删掉省几十 KB
for (const f of ['manifest.webmanifest']) rmSync(join(www, f), { force: true })

// 没注入服务器地址的产物会把 localhost:4471 当默认服务器，装到手机上谁也连不上，提前喊一声
const jsName = readFileSync(html, 'utf8').match(/assets\/(index-[^"]+\.js)/)[1]
const js = readFileSync(join(www, 'assets', jsName), 'utf8')
if (js.includes('localhost:4471')) {
  console.warn('注意：这份产物没有注入 VITE_CLOUDNOTE_SERVER，默认会连 localhost:4471')
}
console.log('www/ 就绪')
