import { mkdirSync, writeFileSync, createReadStream, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { httpError } from './auth.js'

const ROOT = resolve(process.env.CLOUDNOTE_UPLOADS || new URL('../data/uploads', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
mkdirSync(ROOT, { recursive: true })

const MAX_BYTES = 10 * 1024 * 1024
const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

/**
 * 图片以 data URL 提交，服务端解码存盘。
 * 文件名是 32 位随机串，URL 本身即凭证——够长到无法枚举，
 * 也让 <img src> 不必携带 Authorization 头。
 */
export function saveDataUrl(userId, dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''))
  if (!m) throw httpError(400, '不是合法的图片数据')
  const ext = TYPES[m[1].toLowerCase()]
  if (!ext) throw httpError(415, `不支持的图片格式：${m[1]}`)

  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) throw httpError(400, '图片内容为空')
  if (buf.length > MAX_BYTES) throw httpError(413, `图片超过 ${MAX_BYTES / 1024 / 1024}MB`)

  const name = `${randomBytes(16).toString('hex')}.${ext}`
  const file = join(ROOT, userId, name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, buf)
  return { path: `/uploads/${userId}/${name}`, bytes: buf.length }
}

const MIME = Object.fromEntries(Object.entries(TYPES).map(([mime, ext]) => [ext, mime]))

/** 读取已上传的图片；路径段做过白名单校验，杜绝跨目录读取 */
export function readUpload(userId, name) {
  if (!/^[0-9a-z]+$/i.test(userId) || !/^[0-9a-f]{32}\.[a-z]+$/i.test(name)) return null
  const file = join(ROOT, userId, name)
  if (!file.startsWith(ROOT) || !existsSync(file)) return null
  const ext = name.split('.').pop().toLowerCase()
  return { stream: createReadStream(file), type: MIME[ext] || 'application/octet-stream', size: statSync(file).size }
}
