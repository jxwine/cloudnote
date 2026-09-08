/**
 * 极简的按 IP / 按账号限流。够挡住在线撞库和上传灌满磁盘这两类问题，
 * 不引依赖：这些本来就是低频操作，一个 Map 足矣。
 */
const buckets = new Map()

/** 定期清掉过期窗口，别让 Map 无限长大 */
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [key, b] of buckets) if (now > b.resetAt) buckets.delete(key)
}, 60_000)
sweeper.unref?.()

function peek(key, windowMs) {
  const bucket = buckets.get(key)
  if (!bucket || Date.now() > bucket.resetAt) {
    buckets.delete(key)
    return null
  }
  return bucket
}

/** 只看不加：够不够额度 */
export function allow(key, limit, windowMs) {
  const bucket = peek(key, windowMs)
  if (!bucket || bucket.count < limit) return { ok: true }
  return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)) }
}

/** 记一次；只在「该罚」的时候调用 */
export function bump(key, windowMs) {
  const bucket = peek(key, windowMs)
  if (bucket) bucket.count++
  else buckets.set(key, { count: 1, resetAt: Date.now() + windowMs })
}

export function reset(key) {
  buckets.delete(key)
}

/* ---- 具体策略 ---- */

/**
 * 登录/注册限流，只统计失败——成功一次就清零，正常用户碰不到这条线。
 *
 * 分两个维度：
 * - 按邮箱严格（默认 5 次），针对某个账号的撞库很快撞墙；
 * - 按 IP 宽松（默认 30 次），挡住换邮箱的批量扫描，又不会因为
 *   同一个出口 IP 下有别人输错密码就把你也锁在门外。
 */
export const AUTH_WINDOW = Number(process.env.CLOUDNOTE_AUTH_WINDOW_MS || 5 * 60_000)
export const AUTH_LIMIT_IP = Number(process.env.CLOUDNOTE_AUTH_LIMIT_IP || 30)
export const AUTH_LIMIT_ID = Number(process.env.CLOUDNOTE_AUTH_LIMIT_ID || 5)

const idKey = (email) => `auth:id:${String(email || '').trim().toLowerCase()}`
const ipKey = (ip) => `auth:ip:${ip}`

/** 够不够额度；两个维度任一超限都拦 */
export function allowAuth(ip, email) {
  const byId = allow(idKey(email), AUTH_LIMIT_ID, AUTH_WINDOW)
  if (!byId.ok) return byId
  return allow(ipKey(ip), AUTH_LIMIT_IP, AUTH_WINDOW)
}

export function bumpAuth(ip, email) {
  bump(idKey(email), AUTH_WINDOW)
  bump(ipKey(ip), AUTH_WINDOW)
}

export function resetAuth(ip, email) {
  reset(idKey(email))
  reset(ipKey(ip))
}

/** 上传：同一账号每分钟最多 60 张，防止把磁盘灌满 */
export function uploadLimiter(req, reply, done) {
  const key = `upload:${req.user.id}`
  const gate = allow(key, 60, 60_000)
  if (!gate.ok) {
    return reply
      .code(429)
      .header('retry-after', gate.retryAfter)
      .send({ error: `上传过于频繁，请 ${gate.retryAfter} 秒后再试` })
  }
  bump(key, 60_000)
  done()
}
