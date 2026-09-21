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
 *   ../android/resources/icon.png       安卓壳的源图，1024px 铺满（@capacitor/assets 再切各密度 + 自适应图标）
 *   ../android/resources/splash.png     启动图 2732px：品牌色底 + 中间一朵云
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
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

const androidRes = resolve(here, '../../android/resources')

/**
 * @param {string} name 输出文件名（含相对目录时写到那里）
 * @param {number} size 边长
 * @param {'round'|'bleed'|'splash'} kind round 圆角透明底；bleed 直角铺满；splash 大底色中间一朵小云
 */
function render(name, size, kind) {
  let body
  if (kind === 'splash') {
    // 云只占中间 22%，启动图各种屏幕比例裁切都不会切到它
    body = `<div style="width:${size}px;height:${size}px;background:#14706a;display:flex;align-items:center;justify-content:center">
      <div style="width:${Math.round(size * 0.32)}px;height:${Math.round(size * 0.32)}px">${svg.replace(/<rect[^>]*\/>/, '')}</div></div>`
  } else {
    body = kind === 'bleed' ? svg.replace(/rx="\d+"/, 'rx="0"') : svg
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:100%;height:100%}
    body>svg{width:${size}px;height:${size}px}
  </style></head><body>${body}</body></html>`
  const page = join(work, `${name.replace('/', '-')}.html`)
  writeFileSync(page, html)
  const out = join(work, name.replace('/', '-'))
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
  const dest = name.startsWith('android/') ? join(androidRes, name.slice('android/'.length)) : join(iconsDir, name)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(out, dest)
  console.log('生成', name, `${size}×${size}`)
}

try {
  render('icon-192.png', 192, 'round')
  render('icon-512.png', 512, 'round')
  render('apple-touch-icon.png', 180, 'bleed')
  render('android/icon.png', 1024, 'bleed')
  render('android/splash.png', 2732, 'splash')
} finally {
  rmSync(work, { recursive: true, force: true })
}
