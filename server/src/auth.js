import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db, newId } from './db.js'

const SECRET = process.env.CLOUDNOTE_SECRET || 'cloudnote-dev-secret-change-me'
const TTL = '30d'

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
const findById = db.prepare('SELECT id, email, display_name, seq FROM users WHERE id = ?')
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
  return { id: row.id, email: row.email, display_name: row.display_name, seq: row.seq }
}

export const getUser = (id) => findById.get(id)

const findRawById = db.prepare('SELECT * FROM users WHERE id = ?')
const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')

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

/** Fastify preHandler：解析 Bearer token，挂载 req.user / req.clientId */
export function authGuard(req, reply, done) {
  const raw = req.headers.authorization || ''
  const payload = raw.startsWith('Bearer ') ? verify(raw.slice(7)) : null
  const user = payload && getUser(payload.uid)
  if (!user) return reply.code(401).send({ error: '登录已失效，请重新登录' })
  req.user = user
  req.clientId = req.headers['x-client-id'] || null
  done()
}
