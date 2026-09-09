import { db, tx, nextSeq, newId } from './db.js'
import {
  register, login, sign, authGuard, adminGuard, httpError,
  changePassword, resetPassword, toUser,
} from './auth.js'
import { broadcast, peerCount, kick, onlineCount, onlineStats } from './hub.js'
import { saveDataUrl, readUpload, uploadsRoot } from './uploads.js'
import { saveStream, readRelease, removeRelease } from './releases.js'
import { allowAuth, bumpAuth, resetAuth, uploadLimiter } from './guard.js'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

/* ---------- 行 → 客户端对象 ---------- */
const toFolder = (r) =>
  r && {
    id: r.id, name: r.name, parentId: r.parent_id, sortOrder: r.sort_order,
    version: r.version, seq: r.seq, deleted: !!r.deleted,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
const toNote = (r) =>
  r && {
    id: r.id, folderId: r.folder_id, title: r.title, content: r.content,
    excerpt: r.excerpt, sortOrder: r.sort_order, version: r.version, seq: r.seq,
    deleted: !!r.deleted, conflictOf: r.conflict_of,
    tags: parseTags(r.tags),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }

/** 标签以 JSON 数组存字符串列，读坏了就当没有 */
function parseTags(raw) {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string').slice(0, 20) : []
  } catch {
    return []
  }
}

/** 先按类型筛，再 trim——直接 String(x) 会把 null / 数字变成 "null" / "123" */
const serializeTags = (tags) =>
  JSON.stringify(
    Array.isArray(tags)
      ? [
          ...new Set(
            tags
              .filter((t) => typeof t === 'string')
              .map((t) => t.trim().slice(0, 24))
              .filter(Boolean)
          ),
        ].slice(0, 20)
      : []
  )

/* ---------- 预编译语句 ---------- */
const Q = {
  foldersSince: db.prepare('SELECT * FROM folders WHERE user_id = ? AND seq > ? ORDER BY seq'),
  notesSince: db.prepare('SELECT * FROM notes WHERE user_id = ? AND seq > ? ORDER BY seq'),
  getFolder: db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?'),
  getNote: db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?'),
  childFolders: db.prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id = ? AND deleted = 0'),
  notesInFolder: db.prepare('SELECT id FROM notes WHERE user_id = ? AND folder_id = ? AND deleted = 0'),
  insFolder: db.prepare(
    'INSERT INTO folders (id,user_id,name,parent_id,sort_order,version,seq,deleted,created_at,updated_at)' +
    ' VALUES (?,?,?,?,?,1,?,0,?,?)'
  ),
  insNote: db.prepare(
    'INSERT INTO notes (id,user_id,folder_id,title,content,excerpt,sort_order,version,seq,deleted,conflict_of,tags,created_at,updated_at)' +
    ' VALUES (?,?,?,?,?,?,?,1,?,0,?,?,?,?)'
  ),
  updFolder: db.prepare(
    'UPDATE folders SET name=?, parent_id=?, sort_order=?, deleted=?,' +
    ' version=version+1, seq=?, updated_at=? WHERE id=? AND user_id=?'
  ),
  updNote: db.prepare(
    'UPDATE notes SET folder_id=?, title=?, content=?, excerpt=?, sort_order=?, deleted=?, tags=?,' +
    ' version=version+1, seq=?, updated_at=? WHERE id=? AND user_id=?'
  ),
  purgeNote: db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?'),
  purgeNoteRevs: db.prepare('DELETE FROM note_revisions WHERE note_id = ? AND user_id = ?'),

  insRev: db.prepare(
    'INSERT INTO note_revisions (id,note_id,user_id,title,content,version,created_at) VALUES (?,?,?,?,?,?,?)'
  ),
  listRevs: db.prepare(
    'SELECT id, title, version, created_at, LENGTH(content) AS size FROM note_revisions' +
    ' WHERE note_id = ? AND user_id = ? ORDER BY created_at DESC'
  ),
  getRev: db.prepare('SELECT * FROM note_revisions WHERE id = ? AND user_id = ?'),
  lastRevAt: db.prepare(
    'SELECT created_at FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1'
  ),
  trimRevs: db.prepare(
    'DELETE FROM note_revisions WHERE note_id = ? AND id NOT IN' +
    ' (SELECT id FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC LIMIT ?)'
  ),

  /* ----- 后台管理 ----- */
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  // 一次查完用户和它的笔记数，避免每行再来一次查询
  // 搜索词为空时调用方传 '%'，让 LIKE 匹配所有行——省掉一条分支 SQL
  listUsers: db.prepare(
    'SELECT u.id, u.email, u.display_name, u.created_at, u.disabled, u.last_active_at,' +
    ' (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id AND n.deleted = 0) AS notes,' +
    ' (SELECT COUNT(*) FROM folders f WHERE f.user_id = u.id AND f.deleted = 0) AS folders' +
    ' FROM users u WHERE u.email LIKE ? OR u.display_name LIKE ?' +
    ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?'
  ),
  countUsersLike: db.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE email LIKE ? OR display_name LIKE ?'
  ),
  getUserRow: db.prepare('SELECT id, email, display_name, disabled FROM users WHERE id = ?'),
  setDisabled: db.prepare('UPDATE users SET disabled = ? WHERE id = ?'),
  dropUser: db.prepare('DELETE FROM users WHERE id = ?'),
  dropUserNotes: db.prepare('DELETE FROM notes WHERE user_id = ?'),
  dropUserFolders: db.prepare('DELETE FROM folders WHERE user_id = ?'),
  dropUserRevs: db.prepare('DELETE FROM note_revisions WHERE user_id = ?'),
  totalNotes: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted = 0'),
  totalFolders: db.prepare('SELECT COUNT(*) AS n FROM folders WHERE deleted = 0'),

  /* ----- 客户端发布包 ----- */
  listReleases: db.prepare('SELECT * FROM releases ORDER BY created_at DESC'),
  getRelease: db.prepare('SELECT * FROM releases WHERE id = ?'),
  latestRelease: db.prepare(
    'SELECT * FROM releases WHERE platform = ? AND published = 1 ORDER BY created_at DESC LIMIT 1'
  ),
  findVersion: db.prepare('SELECT id FROM releases WHERE version = ? AND platform = ?'),
  insRelease: db.prepare(
    'INSERT INTO releases (id,version,platform,filename,size,sha256,notes,published,created_at)' +
    ' VALUES (?,?,?,?,?,?,?,1,?)'
  ),
  updRelease: db.prepare('UPDATE releases SET notes = ?, published = ? WHERE id = ?'),
  dropRelease: db.prepare('DELETE FROM releases WHERE id = ?'),
}

/** releases 行 → 客户端对象 */
const toRelease = (r) =>
  r && {
    id: r.id,
    version: r.version,
    platform: r.platform,
    filename: r.filename,
    size: r.size,
    sha256: r.sha256,
    notes: r.notes,
    published: !!r.published,
    createdAt: r.created_at,
    url: `/downloads/${r.id}/${encodeURIComponent(r.filename)}`,
  }

/** 每篇最多留这么多条历史，且两条快照至少隔这么久——否则每敲几个字就存一版 */
const REVISION_KEEP = 40
const REVISION_GAP_MS = 3 * 60_000

const pick = (v, fallback) => (v === undefined ? fallback : v)

export default async function routes(app) {
  /* ================= 认证 ================= */
  /**
   * 认证接口只对「失败」计数：成功一次就把窗口清零。
   * 正常用户永远碰不到这条线，在线撞库则很快撞墙。
   */
  const guardAuth = (req, reply) => {
    const gate = allowAuth(req.ip, req.body?.email)
    if (gate.ok) return false
    reply
      .code(429)
      .header('retry-after', gate.retryAfter)
      .send({ error: `尝试过于频繁，请 ${gate.retryAfter} 秒后再试` })
    return true
  }

  app.post('/api/auth/register', async (req, reply) => {
    if (guardAuth(req, reply)) return reply
    try {
      const { email, password, displayName } = req.body || {}
      const user = register(email, password, displayName)
      resetAuth(req.ip, email)
      return { token: sign(user), user: toUser(user) }
    } catch (err) {
      bumpAuth(req.ip, req.body?.email)
      throw err
    }
  })

  app.post('/api/auth/login', async (req, reply) => {
    if (guardAuth(req, reply)) return reply
    try {
      const { email, password } = req.body || {}
      const user = login(email, password)
      resetAuth(req.ip, email)
      return { token: sign(user), user: toUser(user) }
    } catch (err) {
      bumpAuth(req.ip, req.body?.email)
      throw err
    }
  })

  /* 图片本身不鉴权：文件名是 32 位随机串，URL 即凭证，
     这样 <img src> 不用带 Authorization 头也能加载 */
  app.get('/uploads/:userId/:name', async (req, reply) => {
    const file = readUpload(req.params.userId, req.params.name)
    if (!file) return reply.code(404).send({ error: '图片不存在' })
    return reply
      .type(file.type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('content-length', file.size)
      .send(file.stream)
  })

  /* ================= 客户端发布包 ================= */
  /**
   * 这两个接口都不鉴权：新用户还没有账号就得先能下到客户端，
   * 桌面端也要在登录之前就能检查更新。
   */
  app.get('/api/update/latest', async (req) => {
    const platform = String(req.query?.platform || 'win32')
    const row = Q.latestRelease.get(platform)
    return row ? toRelease(row) : {}
  })

  app.get('/downloads/:id/:filename', async (req, reply) => {
    const row = Q.getRelease.get(req.params.id)
    if (!row || !row.published) return reply.code(404).send({ error: '安装包不存在' })
    const file = readRelease(req.params.id, req.params.filename)
    if (!file) return reply.code(404).send({ error: '安装包不存在' })
    return reply
      .type('application/octet-stream')
      // 文件名带中文，用 RFC 5987 的写法，浏览器才不会存成乱码
      .header('content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .header('content-length', file.size)
      .send(file.stream)
  })

  /* 以下路由全部要求登录 */
  app.register(async (priv) => {
    priv.addHook('preHandler', authGuard)

    priv.get('/api/me', async (req) => ({
      user: toUser(req.user),
      peers: peerCount(req.user.id, req.clientId),
    }))

    /* ============ 增量拉取：since=0 即全量 ============ */
    priv.get('/api/sync/pull', async (req) => {
      const since = Number(req.query.since || 0)
      const uid = req.user.id
      return {
        seq: req.user.seq,
        folders: Q.foldersSince.all(uid, since).map(toFolder),
        notes: Q.notesSince.all(uid, since).map(toNote),
      }
    })

    /* ================= 图片 ================= */
    priv.post('/api/upload', { preHandler: uploadLimiter }, async (req) => {
      const { dataUrl } = req.body || {}
      const saved = saveDataUrl(req.user.id, dataUrl)
      return { url: saved.path, bytes: saved.bytes }
    })

    /* ================= 目录 ================= */
    priv.post('/api/folders', async (req) => {
      const uid = req.user.id
      const { id, name, parentId = null, sortOrder = Date.now() } = req.body || {}
      const now = Date.now()
      const folder = tx(() => {
        const fid = id || newId()
        Q.insFolder.run(fid, uid, String(name || '未命名目录').slice(0, 120), parentId, sortOrder, nextSeq(uid), now, now)
        return toFolder(Q.getFolder.get(fid, uid))
      })
      broadcast(uid, { type: 'folder:upsert', folder }, req.clientId)
      return folder
    })

    priv.patch('/api/folders/:id', async (req, reply) => {
      const uid = req.user.id
      const cur = Q.getFolder.get(req.params.id, uid)
      if (!cur) throw httpError(404, '目录不存在')
      const body = req.body || {}
      if (body.baseVersion != null && body.baseVersion !== cur.version)
        return reply.code(409).send({ conflict: true, folder: toFolder(cur) })
      if (body.parentId && wouldCycle(uid, cur.id, body.parentId))
        throw httpError(400, '不能把目录移动到它自己的子目录下')

      const folder = tx(() => {
        Q.updFolder.run(
          pick(body.name, cur.name), pick(body.parentId, cur.parent_id),
          pick(body.sortOrder, cur.sort_order), cur.deleted,
          nextSeq(uid), Date.now(), cur.id, uid
        )
        return toFolder(Q.getFolder.get(cur.id, uid))
      })
      broadcast(uid, { type: 'folder:upsert', folder }, req.clientId)
      return folder
    })

    /* 删除目录：递归软删子目录及其下笔记 */
    priv.delete('/api/folders/:id', async (req) => {
      const uid = req.user.id
      const cur = Q.getFolder.get(req.params.id, uid)
      if (!cur) throw httpError(404, '目录不存在')
      const changed = tx(() => softDeleteTree(uid, cur.id))
      for (const f of changed.folders) broadcast(uid, { type: 'folder:upsert', folder: f }, req.clientId)
      for (const n of changed.notes) broadcast(uid, { type: 'note:upsert', note: n }, req.clientId)
      return changed
    })

    /* ================= 笔记 ================= */
    priv.post('/api/notes', async (req) => {
      const uid = req.user.id
      const b = req.body || {}
      const now = Date.now()
      const note = tx(() => {
        const nid = b.id || newId()
        Q.insNote.run(
          nid, uid, b.folderId ?? null, String(b.title || '').slice(0, 200),
          b.content || '', String(b.excerpt || '').slice(0, 300),
          b.sortOrder ?? now, nextSeq(uid), b.conflictOf ?? null, serializeTags(b.tags), now, now
        )
        return toNote(Q.getNote.get(nid, uid))
      })
      broadcast(uid, { type: 'note:upsert', note }, req.clientId)
      return note
    })

    /* 保存笔记：baseVersion 不匹配即返回 409 + 服务端最新版，由客户端生成冲突副本 */
    priv.patch('/api/notes/:id', async (req, reply) => {
      const uid = req.user.id
      const cur = Q.getNote.get(req.params.id, uid)
      if (!cur) throw httpError(404, '笔记不存在')
      const b = req.body || {}
      if (b.baseVersion != null && b.baseVersion !== cur.version)
        return reply.code(409).send({ conflict: true, note: toNote(cur) })

      const note = tx(() => {
        // 正文要被改写时，先把旧的这一版留个快照
        if (b.content !== undefined && b.content !== cur.content) snapshot(uid, cur)
        Q.updNote.run(
          b.folderId === undefined ? cur.folder_id : b.folderId,
          pick(b.title, cur.title), pick(b.content, cur.content), pick(b.excerpt, cur.excerpt),
          pick(b.sortOrder, cur.sort_order), b.deleted != null ? (b.deleted ? 1 : 0) : cur.deleted,
          b.tags === undefined ? cur.tags : serializeTags(b.tags),
          nextSeq(uid), Date.now(), cur.id, uid
        )
        return toNote(Q.getNote.get(cur.id, uid))
      })
      broadcast(uid, { type: 'note:upsert', note }, req.clientId)
      return note
    })

    /* 彻底删除：回收站里「不再保留」用，连同它的历史版本一起抹掉 */
    priv.delete('/api/notes/:id/purge', async (req) => {
      const uid = req.user.id
      const cur = Q.getNote.get(req.params.id, uid)
      if (!cur) throw httpError(404, '笔记不存在')
      tx(() => {
        Q.purgeNoteRevs.run(cur.id, uid)
        Q.purgeNote.run(cur.id, uid)
      })
      // 别端也要把它从列表里去掉
      broadcast(uid, { type: 'note:purged', id: cur.id }, req.clientId)
      return { id: cur.id, purged: true }
    })

    /* ================= 历史版本 ================= */
    priv.get('/api/notes/:id/revisions', async (req) => {
      const uid = req.user.id
      if (!Q.getNote.get(req.params.id, uid)) throw httpError(404, '笔记不存在')
      return {
        revisions: Q.listRevs.all(req.params.id, uid).map((r) => ({
          id: r.id, title: r.title, version: r.version, size: r.size, createdAt: r.created_at,
        })),
      }
    })

    priv.get('/api/revisions/:revId', async (req) => {
      const rev = Q.getRev.get(req.params.revId, req.user.id)
      if (!rev) throw httpError(404, '这个版本不存在')
      return { id: rev.id, noteId: rev.note_id, title: rev.title, content: rev.content,
        version: rev.version, createdAt: rev.created_at }
    })

    /* 恢复到某个历史版本。当前内容会先存一份快照，所以恢复本身也能撤回 */
    priv.post('/api/revisions/:revId/restore', async (req) => {
      const uid = req.user.id
      const rev = Q.getRev.get(req.params.revId, uid)
      if (!rev) throw httpError(404, '这个版本不存在')
      const cur = Q.getNote.get(rev.note_id, uid)
      if (!cur) throw httpError(404, '笔记不存在')

      const note = tx(() => {
        snapshot(uid, cur, true)
        Q.updNote.run(
          cur.folder_id, rev.title, rev.content, String(rev.content).replace(/<[^>]*>/g, ' ').trim().slice(0, 300),
          cur.sort_order, cur.deleted, cur.tags, nextSeq(uid), Date.now(), cur.id, uid
        )
        return toNote(Q.getNote.get(cur.id, uid))
      })
      broadcast(uid, { type: 'note:upsert', note }, req.clientId)
      return note
    })

    /* ================= 修改密码 ================= */
    priv.post('/api/auth/password', async (req) => {
      const { oldPassword, newPassword } = req.body || {}
      changePassword(req.user.id, oldPassword, newPassword)
      return { ok: true }
    })

    priv.delete('/api/notes/:id', async (req) => {
      const uid = req.user.id
      const cur = Q.getNote.get(req.params.id, uid)
      if (!cur) throw httpError(404, '笔记不存在')
      const note = tx(() => {
        Q.updNote.run(cur.folder_id, cur.title, cur.content, cur.excerpt, cur.sort_order,
          1, cur.tags, nextSeq(uid), Date.now(), cur.id, uid)
        return toNote(Q.getNote.get(cur.id, uid))
      })
      broadcast(uid, { type: 'note:upsert', note }, req.clientId)
      return note
    })
  })

  /* ================= 后台管理 ================= */
  /**
   * 管理员由 .env 的 CLOUDNOTE_ADMINS 决定，不是数据库里的角色。
   * 单开一个作用域，先鉴权再判管理员，两个钩子按顺序跑。
   */
  app.register(async (admin) => {
    admin.addHook('preHandler', authGuard)
    admin.addHook('preHandler', adminGuard)

    admin.get('/api/admin/stats', async () => {
      const online = onlineStats()
      return {
        users: Q.countUsers.get().n,
        notes: Q.totalNotes.get().n,
        folders: Q.totalFolders.get().n,
        onlineAccounts: online.accounts,
        onlineSockets: online.sockets,
        releases: Q.listReleases.all().length,
      }
    })

    admin.get('/api/admin/users', async (req) => {
      const q = String(req.query?.q || '').trim()
      const like = q ? `%${q}%` : '%'
      const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), 100)
      const offset = Math.max(Number(req.query?.offset) || 0, 0)
      const rows = Q.listUsers.all(like, like, limit, offset)
      return {
        total: Q.countUsersLike.get(like, like).n,
        limit,
        offset,
        users: rows.map((r) => ({
          id: r.id,
          email: r.email,
          displayName: r.display_name,
          createdAt: r.created_at,
          lastActiveAt: r.last_active_at,
          disabled: !!r.disabled,
          notes: r.notes,
          folders: r.folders,
          online: onlineCount(r.id),
        })),
      }
    })

    admin.patch('/api/admin/users/:id', async (req) => {
      const target = Q.getUserRow.get(req.params.id)
      if (!target) throw httpError(404, '用户不存在')
      const { disabled, password } = req.body || {}

      if (disabled !== undefined) {
        // 把自己停了就再也进不来了，直接挡住
        if (target.id === req.user.id) throw httpError(400, '不能停用自己的账号')
        Q.setDisabled.run(disabled ? 1 : 0, target.id)
        if (disabled) kick(target.id, 'account disabled')
      }
      if (password !== undefined) resetPassword(target.id, password)

      const row = Q.getUserRow.get(target.id)
      return { id: row.id, email: row.email, disabled: !!row.disabled }
    })

    admin.delete('/api/admin/users/:id', async (req) => {
      const target = Q.getUserRow.get(req.params.id)
      if (!target) throw httpError(404, '用户不存在')
      if (target.id === req.user.id) throw httpError(400, '不能删除自己的账号')
      // 不可恢复的操作，要求手输邮箱对上才执行
      if (String(req.body?.confirmEmail || '').trim().toLowerCase() !== target.email)
        throw httpError(400, '确认邮箱不匹配，未执行删除')

      kick(target.id, 'account removed')
      tx(() => {
        Q.dropUserRevs.run(target.id)
        Q.dropUserNotes.run(target.id)
        Q.dropUserFolders.run(target.id)
        Q.dropUser.run(target.id)
      })
      // 图片目录在事务之外删：文件系统回滚不了，宁可留下孤儿文件也别丢数据库一致性
      rmSync(join(uploadsRoot(), target.id), { recursive: true, force: true })
      return { ok: true, email: target.email }
    })

    admin.get('/api/admin/releases', async () => ({
      releases: Q.listReleases.all().map(toRelease),
    }))

    /**
     * 上传安装包。body 是裸二进制（application/octet-stream），
     * 版本号和文件名走请求头——multipart 为了找边界要先缓冲，81MB 没必要过那一道。
     * 全局的 16MB bodyLimit 是给笔记正文定的，这里显式放到 500MB——和 releases.js
     * 里的硬上限对齐。流式解析器其实不经过缓冲，这个值只是把意图写明白。
     */
    admin.post('/api/admin/releases', { bodyLimit: 500 * 1024 * 1024 }, async (req) => {
      const version = String(req.headers['x-version'] || '').trim()
      const platform = String(req.headers['x-platform'] || 'win32').trim()
      const filename = decodeURIComponent(String(req.headers['x-filename'] || '').trim())
      const notes = decodeURIComponent(String(req.headers['x-notes'] || ''))

      if (!/^\d+\.\d+\.\d+/.test(version)) throw httpError(400, '版本号要形如 1.2.0')
      if (!filename) throw httpError(400, '缺少文件名')
      if (Q.findVersion.get(version, platform))
        throw httpError(409, `版本 ${version} 已经存在，请先删除旧的那条`)

      const id = newId()
      const saved = await saveStream(id, filename, req.body)
      Q.insRelease.run(id, version, platform, saved.filename, saved.size, saved.sha256, notes, Date.now())
      return toRelease(Q.getRelease.get(id))
    })

    admin.patch('/api/admin/releases/:id', async (req) => {
      const row = Q.getRelease.get(req.params.id)
      if (!row) throw httpError(404, '版本不存在')
      const notes = req.body?.notes === undefined ? row.notes : String(req.body.notes)
      const published = req.body?.published === undefined ? row.published : (req.body.published ? 1 : 0)
      Q.updRelease.run(notes, published, row.id)
      return toRelease(Q.getRelease.get(row.id))
    })

    admin.delete('/api/admin/releases/:id', async (req) => {
      const row = Q.getRelease.get(req.params.id)
      if (!row) throw httpError(404, '版本不存在')
      Q.dropRelease.run(row.id)
      removeRelease(row.id)
      return { ok: true, version: row.version }
    })
  })
}

/* ---------- 辅助 ---------- */

/**
 * 把笔记「当前这一版」存成快照。两次快照之间留出间隔，
 * 否则连续打字会把历史刷满；每篇只保留最近若干条。
 * force=true 用在恢复操作上——那一步必须留档，否则恢复就没法撤回。
 */
function snapshot(uid, cur, force = false) {
  const now = Date.now()
  if (!force) {
    const last = Q.lastRevAt.get(cur.id)
    if (last && now - last.created_at < REVISION_GAP_MS) return
  }
  Q.insRev.run(newId(), cur.id, uid, cur.title, cur.content, cur.version, now)
  Q.trimRevs.run(cur.id, cur.id, REVISION_KEEP)
}
function wouldCycle(uid, folderId, targetParentId) {
  let p = targetParentId
  const seen = new Set()
  while (p) {
    if (p === folderId) return true
    if (seen.has(p)) return true
    seen.add(p)
    p = Q.getFolder.get(p, uid)?.parent_id ?? null
  }
  return false
}

function softDeleteTree(uid, rootId) {
  const folders = []
  const notes = []
  const stack = [rootId]
  while (stack.length) {
    const fid = stack.pop()
    const f = Q.getFolder.get(fid, uid)
    if (!f || f.deleted) continue
    Q.updFolder.run(f.name, f.parent_id, f.sort_order, 1, nextSeq(uid), Date.now(), f.id, uid)
    folders.push(toFolder(Q.getFolder.get(f.id, uid)))
    for (const n of Q.notesInFolder.all(uid, fid)) {
      const note = Q.getNote.get(n.id, uid)
      Q.updNote.run(note.folder_id, note.title, note.content, note.excerpt, note.sort_order,
        1, note.tags, nextSeq(uid), Date.now(), note.id, uid)
      notes.push(toNote(Q.getNote.get(note.id, uid)))
    }
    for (const c of Q.childFolders.all(uid, fid)) stack.push(c.id)
  }
  return { folders, notes }
}
