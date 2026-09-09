import { mkdirSync, createReadStream, createWriteStream, existsSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { httpError } from './auth.js'

/**
 * 客户端安装包的落盘位置。
 *
 * 和图片分开放：图片是用户内容，安装包是运维资产，备份和清理策略都不一样。
 * 目录结构 ROOT/<releaseId>/<原始文件名>，一个版本一个目录，删版本就是删目录。
 */
const ROOT = resolve(
  process.env.CLOUDNOTE_RELEASES ||
    new URL('../data/releases', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
)
mkdirSync(ROOT, { recursive: true })

/** 安装包上限。留够余量——现在的包 81MB，将来带点资源也不至于撞线 */
const MAX_BYTES = 500 * 1024 * 1024

/** 文件名白名单：允许中文和常见符号，但不许出现路径分隔符和 .. */
const SAFE_NAME = /^[^\\/:*?"<>|\r\n]{1,120}$/

export function safeFilename(name) {
  const clean = String(name || '').trim()
  if (!SAFE_NAME.test(clean) || clean.includes('..')) return null
  return clean
}

/**
 * 边收边写盘，同时算 sha256。
 *
 * 不能先读进 Buffer 再落盘——81MB 进内存本身就够呛，几个人同时传就把进程撑爆了。
 * 中途超限或出错时把半截文件删掉，不留垃圾。
 */
export async function saveStream(id, filename, stream) {
  const name = safeFilename(filename)
  if (!name) throw httpError(400, '文件名不合法')

  const dir = join(ROOT, id)
  const file = join(dir, name)
  if (!file.startsWith(ROOT)) throw httpError(400, '文件名不合法')
  mkdirSync(dir, { recursive: true })

  const hash = createHash('sha256')
  let size = 0
  let tooBig = false

  try {
    await pipeline(
      stream,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length
          if (size > MAX_BYTES) {
            tooBig = true
            throw httpError(413, `安装包超过 ${MAX_BYTES / 1024 / 1024}MB`)
          }
          hash.update(chunk)
          yield chunk
        }
      },
      createWriteStream(file)
    )
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    if (tooBig) throw err
    throw httpError(400, '上传中断：' + (err?.message || '未知错误'))
  }

  if (!size) {
    rmSync(dir, { recursive: true, force: true })
    throw httpError(400, '文件内容为空')
  }
  return { filename: name, size, sha256: hash.digest('hex') }
}

/** 读取安装包。id 是我们自己生成的、文件名做过白名单，再兜一次目录穿越 */
export function readRelease(id, filename) {
  if (!/^[0-9a-z]+$/i.test(id)) return null
  const name = safeFilename(filename)
  if (!name) return null
  const file = join(ROOT, id, name)
  if (!file.startsWith(ROOT) || !existsSync(file)) return null
  return { stream: createReadStream(file), size: statSync(file).size }
}

/** 删掉某个版本的整个目录 */
export function removeRelease(id) {
  if (!/^[0-9a-z]+$/i.test(id)) return
  const dir = join(ROOT, id)
  if (!dir.startsWith(ROOT)) return
  rmSync(dir, { recursive: true, force: true })
}

/** 后台统计用：所有安装包占了多少磁盘 */
export function releasesRoot() {
  return ROOT
}
