/**
 * 最小的 asar 读取器：只为了在不加载一个包的前提下看它的 package.json。
 *
 * 不能用 Electron 自带的 asar 文件系统钩子（fs.readFileSync('x.asar/package.json')）：
 * 那套会把归档句柄缓存起来直到进程退出，看过一眼的文件就再也删不掉、改不了名。
 * 而且钩子把「x.asar」本身也当成归档根目录，直接 open 它会报找不到——
 * 所以读的时候要先把 process.noAsar 打开，让 fs 老老实实按普通文件处理。
 * 这里用裸 fs 按格式读：
 *
 *   [0..4)   固定 4
 *   [4..8)   头部 pickle 大小 S
 *   [8..12)  字符串 pickle 大小
 *   [12..16) 头部 JSON 的字节长度 L
 *   [16..16+L) 头部 JSON，files 树里每个文件有 size 和相对数据区的 offset
 *   数据区从 8 + S 开始
 */
import { closeSync, openSync, readSync } from 'node:fs'

interface AsarEntry {
  size?: number
  offset?: string
  unpacked?: boolean
  files?: Record<string, AsarEntry>
}

/**
 * 关掉 Electron 的 asar 钩子跑一段 fs 操作。凡是对 .asar 文件本身（而不是它里面的东西）
 * 做 stat / rename / rm 的地方都要套一层，否则钩子会把它当目录处理，行为不可预期。
 */
export function withoutAsar<T>(fn: () => T): T {
  const prev = process.noAsar
  process.noAsar = true
  try {
    return fn()
  } finally {
    process.noAsar = prev
  }
}

/** 读归档里一个文件的内容。文件不存在、归档不合法都返回 null，不抛 */
export function readAsarFile(archive: string, innerPath: string): Buffer | null {
  return withoutAsar(() => readRaw(archive, innerPath))
}

function readRaw(archive: string, innerPath: string): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(archive, 'r')
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16 || head.readUInt32LE(0) !== 4) return null
    const headerSize = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) return null

    const json = Buffer.alloc(jsonLength)
    if (readSync(fd, json, 0, jsonLength, 16) !== jsonLength) return null
    let node = JSON.parse(json.toString('utf8')) as AsarEntry
    for (const part of innerPath.split('/')) {
      const next = node.files?.[part]
      if (!next) return null
      node = next
    }
    if (node.files || node.unpacked || typeof node.size !== 'number' || node.offset === undefined) return null

    const data = Buffer.alloc(node.size)
    const start = 8 + headerSize + Number(node.offset)
    if (readSync(fd, data, 0, node.size, start) !== node.size) return null
    return data
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
