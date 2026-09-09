import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db, newId } from './db.js'

const SECRET = process.env.CLOUDNOTE_SECRET || 'cloudnote-dev-secret-change-me'
const TTL = '30d'

/**
 * 管理员名单来自 .env 的 CLOUDNOTE_ADMINS（逗号分隔的邮箱）。
 *
 * 故意不进数据库：权限不会被界面误改，丢了权限 SSH 改一行重启就回来了。
 * 代价是加减管理员要重启服务——对一个自用服务来说这个代价可以接受。
 * 留空就是没有人能进后台。
 */
const ADMINS = new Set(
  String(process.env.CLOUDNOTE_ADMINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
)

export const isAdmin = (user) => !!user && ADMINS.has(String(user.email || '').toLowerCase())

/** 行 → 客户端对象。register / login / /api/me 三处都走这里，字段口径才一致 */
export const toUser = (row) => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  seq: row.seq,
  isAdmin: isAdmin(row),
})

export const sign = (user) =>
  jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: TTL })

export function verify(token) {
  try {
    return jwt.verify(token, SECRET)
  } catch {
    return null
  }
}

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?')
const findById = db.prepare(
  'SELECT id, email, display_name, seq, disabled, last_active_at FROM users WHERE id = ?'
)
const insertUser = db.prepare(
  'INSERT INTO users (id, email, password_hash, display_name, seq, created_at) VALUES (?, ?, ?, ?, 0, ?)'
)

export function register(email, password, displayName) {
  email = String(email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, '邮箱格式不正确')
  if (String(password || '').length < 6) throw httpError(400, '密码至少 6 位')
  if (findByEmail.get(email)) throw httpError(409, '该邮箱已注册')
  const id = newId()
  insertUser.run(id, email, bcrypt.hashSync(password, 10), displayName?.trim() || email.split('@')[0], Date.now())
  return findById.get(id)
}

export function login(email, password) {
  const row = findByEmail.get(String(email || '').trim().toLowerCase())
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash))
    throw httpError(401, '邮箱或密码错误')
  // 密码对了才提示停用，否则等于给人一个探测邮箱是否存在的接口
  if (row.disabled) throw httpError(403, '账号已被停用，请联系管理员')
  return { id: row.id, email: row.email, display_name: row.display_name, seq: row.seq, disabled: 0 }
}

export const getUser = (id) => findById.get(id)

const findRawById = db.prepare('SELECT * FROM users WHERE id = ?')
const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')

/** 管理员重置密码：不校验旧密码，因为用户就是忘了才找上来的 */
export function resetPassword(userId, newPassword) {
  const row = findRawById.get(userId)
  if (!row) throw httpError(404, '用户不存在')
  if (String(newPassword || '').length < 6) throw httpError(400, '密码至少 6 位')
  updatePassword.run(bcrypt.hashSync(String(newPassword), 10), userId)
}

export function changePassword(userId, oldPassword, newPassword) {
  const row = findRawById.get(userId)
  if (!row) throw httpError(404, '用户不存在')
  if (!bcrypt.compareSync(String(oldPassword || ''), row.password_hash))
    throw httpError(401, '当前密码不正确')
  if (String(newPassword || '').length < 6) throw httpError(400, '新密码至少 6 位')
  if (bcrypt.compareSync(String(newPassword), row.password_hash))
    throw httpError(400, '新密码不能和当前密码相同')
  updatePassword.run(bcrypt.hashSync(String(newPassword), 10), userId)
}

export function httpError(status, message) {
  const e = new Error(message)
  e.statusCode = status
  return e
}

/** 「最后活跃」节流：同一个人 5 分钟内只写一次，不然每个请求都要落一次盘 */
const ACTIVE_THROTTLE = 5 * 60 * 1000
const touchActive = db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?')

/** Fastify preHandler：解析 Bearer token，挂载 req.user / req.clientId */
export function authGuard(req, reply, done) {
  const raw = req.headers.authorization || ''
  const payload = raw.startsWith('Bearer ') ? verify(raw.slice(7)) : null
  const user = payload && getUser(payload.uid)
  if (!user) return reply.code(401).send({ error: '登录已失效，请重新登录' })
  // 停用的账号连同已发出去的 token 一起失效。客户端见到 401 会自动退到登录页。
  if (user.disabled) return reply.code(401).send({ error: '账号已被停用，请联系管理员' })

  const now = Date.now()
  if (!user.last_active_at || now - user.last_active_at > ACTIVE_THROTTLE) {
    touchActive.run(now, user.id)
    user.last_active_at = now
  }

  req.user = user
  req.clientId = req.headers['x-client-id'] || null
  done()
}

/** 挂在 authGuard 之后：非管理员一律挡掉 */
export function adminGuard(req, reply, done) {
  if (!isAdmin(req.user)) return reply.code(403).send({ error: '需要管理员权限' })
  done()
}
