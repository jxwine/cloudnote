/**
 * 启动加载器——package.json 的 main 指向这里。
 *
 * 只做一件事：看 userData/updates 里有没有比自带版本新的热更新包，有就从那份启动，
 * 没有就启动自带的 index.js。它自己不在热更新范围内（永远跑的是安装包里那份），
 * 所以要尽量小、尽量不出错：出了 bug 只能靠整包更新修。
 *
 * 用 require 而不是 import：路径是运行时才知道的，打包器不能碰。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { markBooting, pickHotPackage } from './hot'

const log = (msg: string) => console.log('[loader] ' + msg)

/** 自带的版本号：这个文件在 app.asar/out/main/ 下，往上两级就是 package.json */
const bundledVersion = (JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string })
  .version

const hot = app.isPackaged ? pickHotPackage(bundledVersion, log) : null

if (hot) {
  log(`从热更新包启动 ${hot.version}：${hot.file}`)
  // 主进程靠这个知道自己是从哪份起的：清理时跳过它，首帧之后清掉启动标记
  process.env.CLOUDNOTE_HOT_ASAR = hot.file
  markBooting(hot.file)
  try {
    require(join(hot.file, hot.main))
  } catch (err) {
    // 主模块加载就炸了（语法错误之类）。它可能已经注册了一半的 app 事件，
    // 在同一个进程里再加载自带的会叠出两份窗口和托盘；干脆重启：
    // 启动标记还在，下一次 pickHotPackage 会把这个包隔离掉，从自带版本起。
    console.error('[loader] 热更新包加载失败，重启回退到自带版本', err)
    app.relaunch()
    app.exit(1)
  }
} else {
  require(join(__dirname, 'index.js'))
}
