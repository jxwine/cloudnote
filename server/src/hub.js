/**
 * WebSocket 连接中心：按 userId 分组，向同账号的其他设备广播变更。
 * 每个连接注册自己的 clientId；广播时可排除变更发起方，避免回声。
 */
const rooms = new Map() // userId -> Set<{ socket, clientId }>

export function join(userId, clientId, socket) {
  let room = rooms.get(userId)
  if (!room) rooms.set(userId, (room = new Set()))
  const member = { socket, clientId }
  room.add(member)
  return () => {
    room.delete(member)
    if (room.size === 0) rooms.delete(userId)
  }
}

/** 向同账号所有设备推送；originClientId 对应的连接会被跳过 */
export function broadcast(userId, payload, originClientId) {
  const room = rooms.get(userId)
  if (!room) return 0
  const frame = JSON.stringify(payload)
  let sent = 0
  for (const m of room) {
    if (originClientId && m.clientId === originClientId) continue
    if (m.socket.readyState !== 1) continue
    try {
      m.socket.send(frame)
      sent++
    } catch {
      /* 连接已失效，等 close 事件清理 */
    }
  }
  return sent
}

/** 当前在线的设备数（用于「其他端正在浏览」的提示） */
export function peerCount(userId, selfClientId) {
  const room = rooms.get(userId)
  if (!room) return 0
  let n = 0
  for (const m of room) if (m.clientId !== selfClientId) n++
  return n
}

/** 某账号当前在线的连接数（后台用，不排除任何人） */
export function onlineCount(userId) {
  return rooms.get(userId)?.size ?? 0
}

/** 全站在线连接数和有连接的账号数 */
export function onlineStats() {
  let sockets = 0
  for (const room of rooms.values()) sockets += room.size
  return { accounts: rooms.size, sockets }
}

/**
 * 把某账号的所有连接踢下线。
 * 停用或删除账号时调用——否则已经建立的 WebSocket 不走鉴权钩子，会一直连着收推送。
 */
export function kick(userId, reason = 'account disabled') {
  const room = rooms.get(userId)
  if (!room) return 0
  let n = 0
  for (const m of [...room]) {
    try {
      m.socket.close(4003, reason)
      n++
    } catch {
      /* 已经断了 */
    }
  }
  rooms.delete(userId)
  return n
}
