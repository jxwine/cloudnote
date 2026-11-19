import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHash, randomUUID } from 'node:crypto'
import { db, newId } from './db.js'

const SECRET = process.env.CLOUDNOTE_SECRET || 'cloudnote-dev-secret-change-me'
const TTL = '30d'
export const SESSION_REVOKED_CODE = 4004
const SESSION_REVOKED_REASON = '此设备已被踢出，请重新登录'

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
  jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: TTL, jwtid: randomUUID() })

/**
 * token 是不是在管理员重置密码之前签的。jwt 的 iat 只精确到秒，比较也按秒来：
 * 重置后同一秒内重新登录拿到的新 token 必须算有效，否则用户改完密码马上登录会被误拒。
 */
const tokenPredatesReset = (payload, user) =>
  !!user?.password_reset_at && (payload?.iat || 0) < Math.floor(user.password_reset_at / 1000)

function verify(token) {
  try {
    return jwt.verify(token, SECRET)
  } catch {
    return null
  }
}

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?')
const findById = db.prepare(
  'SELECT id, email, display_name, seq, disabled, last_active_at, password_reset_at FROM users WHERE id = ?'
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

const findRevokedSession = db.prepare('SELECT 1 FROM revoked_sessions WHERE user_id = ? AND id = ?')
const insertRevokedSession = db.prepare('INSERT OR IGNORE INTO revoked_sessions (user_id, id, expires_at) VALUES (?, ?, ?)')
const deleteExpiredSessions = db.prepare('DELETE FROM revoked_sessions WHERE expires_at <= ?')
deleteExpiredSessions.run(Math.floor(Date.now() / 1000))

export function revokeSession(userId, { id, expiresAt }) {
  deleteExpiredSessions.run(Math.floor(Date.now() / 1000))
  insertRevokedSession.run(userId, id, expiresAt)
}

/** HTTP 和实时连接共用凭证校验。旧凭证用已签名的内容派生会话 ID。 */
export function authenticate(token) {
  const payload = typeof token === 'string' && verify(token)
  const user = payload && typeof payload.uid === 'string' && findById.get(payload.uid)
  if (!user || !Number.isInteger(payload.exp)) return { error: '登录已失效，请重新登录' }
  if (user.disabled) return { error: '账号已被停用，请联系管理员' }
  if (tokenPredatesReset(payload, user)) return { error: '密码已被重置，请用新密码重新登录' }

  const id = payload.jti || 'legacy-' + createHash('sha256').update(token.slice(0, token.lastIndexOf('.'))).digest('hex')
  if (findRevokedSession.get(user.id, id)) return { error: SESSION_REVOKED_REASON, revoked: true }
  return { user, session: { id, expiresAt: payload.exp } }
}

const findRawById = db.prepare('SELECT * FROM users WHERE id = ?')
const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
const updatePasswordByAdmin = db.prepare('UPDATE users SET password_hash = ?, password_reset_at = ? WHERE id = ?')

/** 阅读密码重设只验证账号，不使现有登录失效。 */
export async function verifyAccountPassword(userId, password) {
  const row = findRawById.get(userId)
  if (!row || typeof password !== 'string' || password.length > 1024 ||
      !await bcrypt.compare(password, row.password_hash))
    throw httpError(403, '账号密码不正确')
}

/** 管理员重置密码：不校验旧密码，因为用户就是忘了才找上来的 */
export function resetPassword(userId, newPassword) {
  const row = findRawById.get(userId)
  if (!row) throw httpError(404, '用户不存在')
  if (String(newPassword || '').length < 6) throw httpError(400, '密码至少 6 位')
  // 记下时间点：之前签出去的 token 从此失效（authGuard 里比较），已登录的设备得用新密码重新登录。
  // 用户自己改密码不走这条——那种情况当前设备还想继续用，token 不该作废
  updatePasswordByAdmin.run(bcrypt.hashSync(String(newPassword), 10), Date.now(), userId)
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

/** Fastify preHandler：解析 Bearer token，挂载账号、登录会话和同步来源。 */
export function authGuard(req, reply, done) {
  const raw = req.headers.authorization || ''
  const auth = authenticate(raw.startsWith('Bearer ') ? raw.slice(7) : null)
  if (auth.error) return reply.code(401).send({ error: auth.error })
  const { user, session } = auth

  const now = Date.now()
  if (!user.last_active_at || now - user.last_active_at > ACTIVE_THROTTLE) {
    touchActive.run(now, user.id)
    user.last_active_at = now
  }

  req.user = user
  req.session = session
  req.clientId = req.headers['x-client-id'] || null
  done()
}

/** 挂在 authGuard 之后：非管理员一律挡掉 */
export function adminGuard(req, reply, done) {
  if (!isAdmin(req.user)) return reply.code(403).send({ error: '需要管理员权限' })
  done()
}
