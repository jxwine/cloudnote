/**
 * 数据清理。默认只报告不动手，确认无误后加 --apply 才真删。
 *
 *   node scripts/gc.js                  看看有什么可清理的
 *   node scripts/gc.js --apply          真的删
 *   node scripts/gc.js --days 90 --apply  软删超过 90 天的才清（默认 30）
 *
 * 做两件事：
 * 1. 把软删够久的笔记和目录彻底删掉——软删记录会一直留在库里，
 *    多端同步靠它传递「这条没了」，但过了同步窗口就没有保留价值了。
 * 2. 删掉没有任何笔记引用的上传图片。笔记删了图片不会跟着删，
 *    因为笔记可能被撤销恢复，删早了图就回不来了。
 */
import { readdirSync, statSync, unlinkSync, rmdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { db } from '../src/db.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const days = Number(args[args.indexOf('--days') + 1]) || 30
const cutoff = Date.now() - days * 86400_000

const UPLOAD_ROOT = resolve(
  process.env.CLOUDNOTE_UPLOADS || new URL('../data/uploads', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
)

const fmt = (n) => n.toLocaleString('zh-CN')

/* ---------- 1. 过期的软删记录 ---------- */

const staleNotes = db
  .prepare('SELECT id, title, updated_at FROM notes WHERE deleted = 1 AND updated_at < ?')
  .all(cutoff)
const staleFolders = db
  .prepare('SELECT id, name, updated_at FROM folders WHERE deleted = 1 AND updated_at < ?')
  .all(cutoff)

console.log(`\n软删超过 ${days} 天的记录`)
console.log(`  笔记 ${fmt(staleNotes.length)} 条，目录 ${fmt(staleFolders.length)} 个`)
for (const n of staleNotes.slice(0, 5)) console.log(`    · ${n.title || '(无标题)'}`)
if (staleNotes.length > 5) console.log(`    … 还有 ${staleNotes.length - 5} 条`)

/* ---------- 2. 没人引用的图片 ---------- */

// 软删的笔记也算引用：它们还可能被撤销恢复
const referenced = new Set()
for (const row of db.prepare('SELECT content FROM notes').all()) {
  for (const m of String(row.content || '').matchAll(/\/uploads\/([A-Za-z0-9]+)\/([0-9a-f]{32}\.[a-z]+)/g)) {
    referenced.add(`${m[1]}/${m[2]}`)
  }
}

const orphans = []
let totalBytes = 0
if (existsSync(UPLOAD_ROOT)) {
  for (const userDir of readdirSync(UPLOAD_ROOT)) {
    const dir = join(UPLOAD_ROOT, userDir)
    if (!statSync(dir).isDirectory()) continue
    for (const file of readdirSync(dir)) {
      if (referenced.has(`${userDir}/${file}`)) continue
      const full = join(dir, file)
      const size = statSync(full).size
      orphans.push({ full, rel: `${userDir}/${file}`, size })
      totalBytes += size
    }
  }
}

console.log(`\n没有任何笔记引用的图片`)
console.log(`  ${fmt(orphans.length)} 个文件，共 ${(totalBytes / 1024).toFixed(1)} KB`)
for (const o of orphans.slice(0, 5)) console.log(`    · ${o.rel}`)
if (orphans.length > 5) console.log(`    … 还有 ${orphans.length - 5} 个`)

/* ---------- 执行 ---------- */

if (!apply) {
  console.log('\n以上只是报告。确认无误后加 --apply 真正执行。\n')
  process.exit(0)
}

const delNote = db.prepare('DELETE FROM notes WHERE id = ?')
const delFolder = db.prepare('DELETE FROM folders WHERE id = ?')
db.exec('BEGIN IMMEDIATE')
try {
  for (const n of staleNotes) delNote.run(n.id)
  for (const f of staleFolders) delFolder.run(f.id)
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('清理数据库失败，已回滚：', err.message)
  process.exit(1)
}

let removed = 0
for (const o of orphans) {
  try {
    unlinkSync(o.full)
    removed++
  } catch {
    /* 文件可能刚被别的进程动过，跳过 */
  }
}

// 顺手收掉空的用户目录
if (existsSync(UPLOAD_ROOT)) {
  for (const userDir of readdirSync(UPLOAD_ROOT)) {
    const dir = join(UPLOAD_ROOT, userDir)
    try {
      if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir)
    } catch {
      /* 非空或没权限就留着 */
    }
  }
}

db.exec('VACUUM')
console.log(
  `\n已清理：笔记 ${fmt(staleNotes.length)} 条、目录 ${fmt(staleFolders.length)} 个、图片 ${fmt(removed)} 个，数据库已压缩。\n`
)
