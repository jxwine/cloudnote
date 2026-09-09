// node:sqlite 是 Node 内置的，Node 24 起稳定可用；22.5~23.3 需要 --experimental-sqlite。
// 版本不对时给一句能看懂的话，别让人对着模块解析错误发愣。
let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  const v = process.versions.node
  console.error(
    `
  启动失败：当前 Node 版本 ${v} 用不了内置的 node:sqlite。
` +
      `  请升级到 Node 24 或更高（推荐），或在 Node 22.5~23.3 上加 --experimental-sqlite 启动。
`
  )
  process.exit(1)
}
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DB_PATH = resolve(process.env.CLOUDNOTE_DB || new URL('../data/cloudnote.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  -- 停用后无法登录，已登录的设备下一次请求就被挡回去。数据保留，随时可恢复。
  disabled      INTEGER NOT NULL DEFAULT 0,
  -- 后台的「最后活跃」。鉴权钩子里节流写，不是每个请求都更新。
  last_active_at INTEGER
);

CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  parent_id  TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,
  seq        INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_user_seq ON folders(user_id, seq);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  folder_id   TEXT,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  excerpt     TEXT NOT NULL DEFAULT '',
  sort_order  REAL NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  seq         INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  conflict_of TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user_seq ON notes(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(user_id, folder_id);

-- 历史版本。存的是「被覆盖掉的那一版」，不是当前版本，
-- 所以最新内容始终只在 notes 表里一份，这里纯粹是回溯用的。
CREATE TABLE IF NOT EXISTS note_revisions (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_note ON note_revisions(note_id, created_at DESC);

-- 客户端安装包。文件本身落在 CLOUDNOTE_RELEASES 目录，这里只存元信息。
-- sha256 是上传时边写盘边算的，客户端下载完会自己校验一遍。
CREATE TABLE IF NOT EXISTS releases (
  id         TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT 'win32',
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  published  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(version, platform)
);
`)

/* ---------- 迁移：给老库补上后加的列 ---------- */
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

// 标签存成 JSON 数组字符串。笔记的标签通常只有几个，
// 单独开表要多一次 join，收益抵不上复杂度。
addColumn('notes', 'tags', "TEXT NOT NULL DEFAULT '[]'")
addColumn('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0')
addColumn('users', 'last_active_at', 'INTEGER')

/** 为某用户取下一个单调递增的变更序号（增量同步游标） */
const bumpSeq = db.prepare('UPDATE users SET seq = seq + 1 WHERE id = ?')
const readSeq = db.prepare('SELECT seq FROM users WHERE id = ?')
export function nextSeq(userId) {
  bumpSeq.run(userId)
  return readSeq.get(userId).seq
}

/** 把语句包进一个事务里执行，异常自动回滚 */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
