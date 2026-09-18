/**
 * 把 src/renderer/public/icons/icon.svg 渲染成 PWA 需要的几张 PNG。
 *
 * 项目里没有 sharp / canvas 这类依赖，也不想为几张图标加一个原生模块，
 * 所以直接拿本机 Chrome 无头模式截图：把 SVG 塞进一页 HTML，窗口开成图标大小，--screenshot。
 *
 *   node scripts/make-icons.mjs
 *
 * 产物提交进仓库，改图标时重跑一次即可：
 *   icons/icon-192.png / icon-512.png   manifest 用，圆角外面透明
 *   icons/apple-touch-icon.png          iOS 用，180px、整张铺满不留透明（iOS 自己切圆角，透明处会垫成黑色）
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const iconsDir = resolve(here, '../src/renderer/public/icons')
const svg = readFileSync(join(iconsDir, 'icon.svg'), 'utf8')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chrome) {
  console.error('找不到 Chrome。装一个，或者用 CHROME_PATH=... 指过来。')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'cloudnote-icons-'))
const profile = join(work, 'profile')

/**
 * @param {string} name 输出文件名
 * @param {number} size 边长
 * @param {boolean} bleed true 就把圆角铺成直角、整张填满品牌色（apple-touch-icon 用）
 */
function render(name, size, bleed) {
  const body = bleed ? svg.replace(/rx="\d+"/, 'rx="0"') : svg
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>${body}</body></html>`
  const page = join(work, `${name}.html`)
  writeFileSync(page, html)
  const out = join(work, name)
  const r = spawnSync(
    chrome,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      pathToFileURL(page).href,
    ],
    { stdio: 'pipe', timeout: 60_000 }
  )
  // Windows 上 chrome.exe 会先退出、由它拉起的子进程才真正干活，spawnSync 返回时文件多半还没落地，等一下
  const deadline = Date.now() + 30_000
  while (!existsSync(out) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  if (r.status !== 0 || !existsSync(out)) {
    console.error(`渲染 ${name} 失败`, r.stderr?.toString().slice(-800))
    process.exit(1)
  }
  // 再等文件写完（大小两次一样）
  let last = -1
  for (;;) {
    const size = statSync(out).size
    if (size > 0 && size === last) break
    last = size
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  copyFileSync(out, join(iconsDir, name))
  console.log('生成', join('icons', name), `${size}×${size}`)
}

try {
  render('icon-192.png', 192, false)
  render('icon-512.png', 512, false)
  render('apple-touch-icon.png', 180, true)
} finally {
  rmSync(work, { recursive: true, force: true })
}
