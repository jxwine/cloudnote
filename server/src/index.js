// 必须是第一行：ESM 的 import 会提升，晚一步 db.js 就已经读过 process.env 了
import './env.js'

import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import routes from './routes.js'
import { verify, getUser } from './auth.js'
import { join, broadcast, peerCount } from './hub.js'

const PORT = Number(process.env.PORT || 4471)
const HOST = process.env.HOST || '0.0.0.0'

const app = Fastify({
  logger: { transport: undefined, level: process.env.LOG_LEVEL || 'warn' },
  bodyLimit: 16 * 1024 * 1024, // 单篇笔记上限 16MB
})

await app.register(cors, { origin: true })
await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } })
// DELETE 之类的请求常带 content-type 却没有 body，内置解析器会直接 400，这里换成宽容版本
app.removeContentTypeParser('application/json')
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body || !body.trim()) return done(null, {})
  try {
    done(null, JSON.parse(body))
  } catch {
    const err = new Error('请求体不是合法的 JSON')
    err.statusCode = 400
    done(err)
  }
})

// 必须早于路由注册：晚了子作用域就用不上，业务错误文案会被 Fastify 的默认消息顶掉
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode || 500
  if (status >= 500) req.log.error(err)
  reply.code(status).send({ error: err.message || '服务器内部错误' })
})

await app.register(routes)

app.get('/health', async () => ({ ok: true, ts: Date.now() }))

/**
 * 实时通道。客户端连接 /ws?token=<jwt>&clientId=<设备标识>
 * 服务端只做广播，不接受业务写入——所有写入走 REST，保证版本号单一权威。
 */
app.get('/ws', { websocket: true }, (socket, req) => {
  const token = req.query?.token
  const clientId = req.query?.clientId || 'anon'
  const payload = token ? verify(token) : null
  const user = payload && getUser(payload.uid)

  if (!user) {
    socket.send(JSON.stringify({ type: 'error', message: '未授权' }))
    socket.close(4001, 'unauthorized')
    return
  }

  const leave = join(user.id, clientId, socket)
  socket.send(JSON.stringify({ type: 'ready', seq: user.seq, peers: peerCount(user.id, clientId) }))
  // 告知其他设备：有新端上线（用于「其他端正在浏览」提示）
  broadcast(user.id, { type: 'presence', peers: peerCount(user.id, null) }, null)

  let alive = true
  socket.on('pong', () => { alive = true })
  const ping = setInterval(() => {
    if (!alive) return socket.terminate()
    alive = false
    try { socket.ping() } catch { /* 连接已断 */ }
  }, 30_000)

  socket.on('message', (raw) => {
    // 目前只处理客户端心跳，其余消息忽略
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
    } catch { /* 非 JSON，忽略 */ }
  })

  socket.on('close', () => {
    clearInterval(ping)
    leave()
    broadcast(user.id, { type: 'presence', peers: peerCount(user.id, null) }, null)
  })
})

await app.listen({ port: PORT, host: HOST })
console.log(`\n  云笔记服务已启动`)
console.log(`  REST      http://localhost:${PORT}/api`)
console.log(`  WebSocket ws://localhost:${PORT}/ws\n`)
