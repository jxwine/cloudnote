/**
 * 热更新包的落盘约定与挑选逻辑。loader 和主进程都用这一份。
 *
 * 安装包 84 MB 里我们自己的代码只有 2 MB（resources/app.asar），其余全是 Electron 运行时。
 * 小版本更新只换这 2 MB：下载一份新的 asar 放到 userData/updates/，下次启动 loader 从它起。
 * 运行时本身（Electron 大版本）变了还是得发整包，包里声明的 Electron 主版本不对就不会被加载。
 *
 * Windows 上正在运行的 asar **删不掉但能被覆盖写**——所以永远写新文件名、绝不原地覆盖，
 * 旧文件留到下次启动再清。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readAsarFile, withoutAsar } from './asar'

export interface HotPackage {
  file: string
  version: string
  /** 包要求的 Electron 主版本 */
  electron: string
  main: string
}

export const updatesDir = (): string => join(app.getPath('userData'), 'updates')

/** loader 加载某个包之前写下它，主进程首帧之后删掉；下次启动还在就说明那个包起不来 */
const bootMarker = (): string => join(updatesDir(), 'booting.json')

export const runtimeMajor = (): string => process.versions.electron.split('.')[0]

/** 只看前三段数字。>0 表示 a 更新 */
export function compareVersion(a: string, b: string): number {
  const parse = (v: string) => String(v || '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * 读一个 asar 文件的 package.json，拿出我们关心的字段。读不了、缺字段都返回 null。
 * 用的是裸文件读取，不经过 Electron 的 asar 钩子：那套会缓存句柄，文件就删不掉了。
 */
export function inspectHotPackage(file: string): HotPackage | null {
  try {
    const raw = readAsarFile(file, 'package.json')
    if (!raw) return null
    const pkg = JSON.parse(raw.toString('utf8')) as {
      version?: string
      main?: string
      cloudnote?: { electron?: string }
    }
    if (!pkg.version || !pkg.main || !pkg.cloudnote?.electron) return null
    return { file, version: pkg.version, electron: String(pkg.cloudnote.electron).split('.')[0], main: pkg.main }
  } catch {
    return null
  }
}

/**
 * 在 updates/ 里挑一个可用的包：比自带版本新、Electron 主版本对得上、版本最高的那份。
 * 上次没起来的包先隔离掉。
 */
export function pickHotPackage(bundledVersion: string, log: (msg: string) => void): HotPackage | null {
  return withoutAsar(() => pick(bundledVersion, log))
}

function pick(bundledVersion: string, log: (msg: string) => void): HotPackage | null {
  const dir = updatesDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }

  // 上次启动写了标记却没清掉：那个包起不来，改名隔离，回退到别的。
  // 写标记的进程要是还活着（用户双击了第二次，正在起的那个还没出首帧），就不是崩溃，别动它。
  const marker = bootMarker()
  if (existsSync(marker)) {
    try {
      const { file, pid } = JSON.parse(readFileSync(marker, 'utf8')) as { file?: string; pid?: number }
      if (pid && pid !== process.pid && isAlive(pid)) return null
      if (file && existsSync(file)) {
        // 顺手把版本记进拒绝名单：服务端上那条还在的话，检查更新不能再把它推回来
        const bad = inspectHotPackage(file)
        if (bad) rememberRejected(bad.version)
        renameSync(file, file + '.bad')
        log(`上次从 ${file} 启动没成功，已隔离`)
      }
    } catch {
      /* 标记本身坏了就当没有 */
    }
    rmSync(marker, { force: true })
    names = readdirSync(dir)
  }

  let best: HotPackage | null = null
  for (const name of names) {
    if (!name.endsWith('.asar')) continue
    const pkg = inspectHotPackage(join(dir, name))
    if (!pkg) {
      log(`跳过 ${name}：读不出 package.json`)
      continue
    }
    if (pkg.electron !== runtimeMajor()) {
      log(`跳过 ${name}：要 Electron ${pkg.electron}，运行时是 ${runtimeMajor()}`)
      continue
    }
    if (compareVersion(pkg.version, bundledVersion) <= 0) continue
    if (!best || compareVersion(pkg.version, best.version) > 0) best = pkg
  }
  return best
}

/**
 * settings.json 里的 rejectedHot：起不来或 Electron 不匹配的热更新版本，检查更新时跳过。
 * 主进程 index.ts 也读写这个文件（主题等），这里只合并这一个字段，别的原样保留。
 */
export function rememberRejected(version: string): void {
  const file = join(app.getPath('userData'), 'settings.json')
  try {
    let settings: { rejectedHot?: string[] } = {}
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as typeof settings
    } catch {
      /* 没有就从空的开始 */
    }
    const set = new Set(settings.rejectedHot ?? [])
    set.add(version)
    writeFileSync(file, JSON.stringify({ ...settings, rejectedHot: [...set] }), 'utf8')
  } catch {
    /* 记不下就算了，最多再下一次 */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function markBooting(file: string): void {
  try {
    mkdirSync(updatesDir(), { recursive: true })
    writeFileSync(bootMarker(), JSON.stringify({ file, pid: process.pid, at: Date.now() }), 'utf8')
  } catch {
    /* 写不了就没有崩溃保护，不至于因此不启动 */
  }
}

export function clearBooting(): void {
  rmSync(bootMarker(), { force: true })
}

/**
 * 清掉用不上的东西：没选中的包、隔离的包、半截下载。
 * 正在用的那份跳过；删不掉的（还被别的进程占着）也不管，下次再说。
 */
export function cleanupUpdates(keep: string | null): void {
  withoutAsar(() => {
    let names: string[]
    try {
      names = readdirSync(updatesDir())
    } catch {
      return
    }
    for (const name of names) {
      const file = join(updatesDir(), name)
      if (file === keep || name === 'booting.json') continue
      if (!/\.(asar|asar\.bad|download)$/.test(name)) continue
      try {
        rmSync(file, { force: true })
      } catch {
        /* 占着就留着 */
      }
    }
  })
}
