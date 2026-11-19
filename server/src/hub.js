/**
 * WebSocket 连接中心：按 userId 分组，向同账号的其他设备广播变更。
 * 广播按 clientId 排除同步回声，在线端管理按已认证的登录会话分组。
 */
const rooms = new Map() // userId -> Set<连接>

const platforms = [
  [/iPad/, 'iPad'], [/iPhone|iPod/, 'iPhone'], [/Android/, 'Android'],
  [/Windows/, 'Windows'], [/Macintosh|Mac OS/, 'macOS'], [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux'],
]

function describeDevice(ua) {
  const platform = platforms.find(([pattern]) => pattern.test(ua))?.[1]
  let app = '网页端'
  if (/Electron\//.test(ua)) app = '桌面端'
  else if (platform === 'Android' && /; wv\)/.test(ua)) app = '客户端'
  else if (/Edg(?:A|iOS)?\//.test(ua)) app = 'Edge'
  else if (/OPR\//.test(ua)) app = 'Opera'
  else if (/SamsungBrowser\//.test(ua)) app = '三星浏览器'
  else if (/Firefox\/|FxiOS\//.test(ua)) app = 'Firefox'
  else if (/Chrome\/|CriOS\//.test(ua)) app = 'Chrome'
  else if (/Safari\//.test(ua)) app = 'Safari'
  return [platform, app].filter(Boolean).join(' ')
}

export function join(userId, clientId, session, userAgent, socket) {
  let room = rooms.get(userId)
  if (!room) rooms.set(userId, (room = new Set()))
  const member = { socket, clientId, session, name: describeDevice(userAgent), connectedAt: Date.now() }
  room.add(member)
  return () => {
    if (!room.delete(member) || rooms.get(userId) !== room) return false
    if (room.size === 0) rooms.delete(userId)
    return true
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

function onlineSessions(userId) {
  const sessions = new Map()
  for (const member of rooms.get(userId) ?? []) {
    if (member.socket.readyState === 1 && !sessions.has(member.session.id)) {
      sessions.set(member.session.id, member)
    }
  }
  return sessions
}

/** 同一登录打开多个窗口仍算一端。 */
export function peerCount(userId, selfSessionId) {
  const sessions = onlineSessions(userId)
  if (selfSessionId) sessions.delete(selfSessionId)
  return sessions.size
}

export function announcePresence(userId) {
  broadcast(userId, { type: 'presence', peers: peerCount(userId) })
}

export function onlineDevices(userId, selfSessionId) {
  return [...onlineSessions(userId).values()].map(({ session, name, connectedAt }) => ({
    id: session.id, name, connectedAt, current: session.id === selfSessionId,
  })).sort((a, b) => Number(b.current) - Number(a.current) || b.connectedAt - a.connectedAt)
}

export function findOnlineSession(userId, id) {
  return onlineSessions(userId).get(id)?.session
}

export function kickSession(userId, id, code) {
  const room = rooms.get(userId)
  if (!room) return
  for (const member of room) {
    if (member.session.id !== id) continue
    room.delete(member)
    member.socket.close(code, 'session revoked')
  }
  if (!room.size) rooms.delete(userId)
  announcePresence(userId)
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
