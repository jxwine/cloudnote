import { pbkdf2, randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { httpError } from './auth.js'
import { allow, bump } from './guard.js'

const derive = promisify(pbkdf2)
export const READING_LOCK_ITERATIONS = 210000

export const parseReadingLock = (raw) => raw ? JSON.parse(raw) : null

export function rejectReadingLockFields(body) {
  if (body && ['readingLock', 'reading_lock', 'password', 'accountPassword', 'baseLockRevision']
    .some((key) => Object.hasOwn(body, key)))
    throw httpError(400, '请使用专用阅读密码接口修改密码')
}

export function validateReadingLockInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Object.hasOwn(body, 'password') || !Object.hasOwn(body, 'baseLockRevision'))
    throw httpError(400, '缺少阅读密码或锁版本')
  if (body.password !== null && (typeof body.password !== 'string' ||
      body.password.length < 6 || body.password.length > 128))
    throw httpError(400, '阅读密码需要 6–128 个字符')
  if (body.baseLockRevision !== null && (typeof body.baseLockRevision !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.baseLockRevision)))
    throw httpError(400, '锁版本格式不正确')
  if (body.accountPassword !== undefined && (typeof body.accountPassword !== 'string' ||
      body.accountPassword.length > 1024))
    throw httpError(400, '账号密码格式不正确')
}

export async function createReadingLock(password) {
  if (password === null) return null
  const salt = randomBytes(16).toString('hex')
  const hash = await derive(password, Buffer.from(salt, 'hex'), READING_LOCK_ITERATIONS, 32, 'sha256')
  return { salt, hash: hash.toString('hex'), iterations: READING_LOCK_ITERATIONS, revision: randomUUID() }
}

/** 每个账号最多 30 次/分钟；账号密码连续试错最多 5 次/5 分钟。 */
export function readingLockLimiter(req, reply, done) {
  const key = `reading-lock:${req.user.id}`
  const gate = allow(`reading-lock-failed:${req.user.id}`, 5, 300_000)
  const requestGate = gate.ok ? allow(key, 30, 60_000) : gate
  if (!requestGate.ok) return reply.code(429).header('retry-after', requestGate.retryAfter)
    .send({ error: `尝试过于频繁，请 ${requestGate.retryAfter} 秒后再试` })
  bump(key, 60_000)
  done()
}

export const recordReadingLockFailure = (userId) => bump(`reading-lock-failed:${userId}`, 300_000)
