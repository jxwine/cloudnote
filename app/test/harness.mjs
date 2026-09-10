/**
 * 起一套完整环境：同步服务 + 网页版 + 两个互相独立的浏览器实例。
 *
 * 每个场景都用**全新的数据库和全新的浏览器数据目录**。
 * 不隔离的话，上一轮留下的笔记会混进断言里——我就因为这个把一次失败读成了通过。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach, sleep, until } from './cdp.mjs'
import { SERVER } from './app.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoDir = join(appDir, '..')

const PORT_SERVER = 4472
const PORT_WEB = 5273
const PORT_A = 9701
const PORT_B = 9702
// 统一用 127.0.0.1：Windows 上 localhost 可能先解析到 ::1，探活和浏览器就对不上了
const WEB_URL = `http://127.0.0.1:${PORT_WEB}/`

// 用正斜杠：Node 在 Windows 上照样认，还免得反斜杠在各种转义里被吃掉
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!hit) {
    throw new Error(
      '找不到 Chrome。装一个，或者用 CHROME_PATH=... 指过来。\n' +
        '这套测试要开两个真实浏览器窗口当两台设备。'
    )
  }
  return hit
}

const procs = []
/**
 * 一律用当前这个 node 去跑入口文件，不碰 npm / npx。
 *
 * Windows 上 spawn 一个 .cmd 会直接 EINVAL（Node 那次命令注入修复之后的行为），
 * 加 shell:true 又要自己处理路径里的空格。绕开它，顺带还省掉一层 npm 启动开销。
 */
function run(file, args, opts = {}) {
  const p = spawn(process.execPath, [file, ...args], { stdio: 'ignore', ...opts })
  procs.push(p)
  return p
}

/** chrome 是真可执行文件，直接 spawn */
function runExe(exe, args) {
  const p = spawn(exe, args, { stdio: 'ignore' })
  procs.push(p)
  return p
}

async function waitPort(port, what, timeout = 30000) {
  await until(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
        return true
      } catch (e) {
        // 连上了但返回 404/其它状态也算起来了，只有连不上才继续等
        return !/ECONNREFUSED|fetch failed|other side closed/i.test(String(e))
      }
    },
    { timeout, what }
  )
}

/** 整套环境只起一次，场景之间靠换数据库和清 localStorage 来隔离 */
export async function bootEnv({ tmpDir }) {
  if (!existsSync(join(appDir, 'out', 'renderer', 'index.html'))) {
    throw new Error('还没有构建产物，先跑：npm --prefix app run build')
  }
  mkdirSync(tmpDir, { recursive: true })

  const dbPath = join(tmpDir, 'sync-test.db')
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

  run(join(repoDir, 'server', 'src', 'index.js'), [], {
    env: {
      ...process.env,
      PORT: String(PORT_SERVER),
      HOST: '127.0.0.1',
      CLOUDNOTE_DB: dbPath,
      CLOUDNOTE_UPLOADS: join(tmpDir, 'uploads'),
      CLOUDNOTE_RELEASES: join(tmpDir, 'releases'),
    },
  })
  await waitPort(PORT_SERVER, '同步服务')

  run(join(appDir, 'node_modules', 'vite', 'bin', 'vite.js'),
    ['preview', '--outDir', 'out/renderer', '--host', '127.0.0.1', '--port', String(PORT_WEB), '--strictPort'],
    { cwd: appDir })
  await waitPort(PORT_WEB, '网页版')

  const chrome = findChrome()
  const headless = process.argv.includes('--headless')
  const devices = []
  for (const [port, label] of [
    [PORT_A, 'A'],
    [PORT_B, 'B'],
  ]) {
    const profile = join(tmpDir, 'chrome-' + label)
    rmSync(profile, { recursive: true, force: true })
    runExe(chrome, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      ...(headless ? ['--headless=new'] : []),
      WEB_URL,
    ])
    await waitPort(port, `浏览器 ${label}`)
    devices.push({ port, name: label })
  }
  await sleep(1500)

  return {
    dbPath,
    async device(which) {
      const d = devices.find((x) => x.name === which)
      return attach(d.port, { urlPart: String(PORT_WEB), name: `设备${which}` })
    },
    async register(email, password, displayName) {
      const r = await fetch(`${SERVER}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      })
      if (!r.ok) throw new Error('注册测试账号失败：' + r.status + ' ' + (await r.text()))
    },
  }
}

export function shutdown() {
  for (const p of procs) {
    try {
      if (process.platform === 'win32' && p.pid) {
        spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        p.kill('SIGKILL')
      }
    } catch {
      /* 收尾失败不该盖掉真正的测试结果 */
    }
  }
}
