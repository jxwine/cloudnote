/**
 * 端到端验证：注册 → 双设备 WS → CRUD 广播 → 版本冲突 → 拖拽归属 → 增量拉取 → 递归删除
 * 用法：先 npm start，再 node test/e2e.js
 */
const BASE = process.env.BASE || 'http://localhost:4471'
let pass = 0, fail = 0

const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}`, extra ?? '') }
}

async function api(method, path, { token, clientId, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(clientId ? { 'x-client-id': clientId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

/** 打开一条 WS 并把收到的消息塞进数组 */
function openWs(token, clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${token}&clientId=${clientId}`)
    const inbox = []
    ws.onmessage = (e) => inbox.push(JSON.parse(e.data))
    ws.onerror = reject
    ws.onopen = () => resolve({ ws, inbox, clientId })
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮询等待 inbox 中出现符合条件的消息 */
async function expectMsg(inbox, predicate, timeout = 1500) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const hit = inbox.find(predicate)
    if (hit) return hit
    await wait(30)
  }
  return null
}

console.log('\n云笔记服务端 E2E 测试\n' + '─'.repeat(46))

/* ---------- 1. 认证 ---------- */
const email = `t${Date.now()}@test.local`
const reg = await api('POST', '/api/auth/register', { body: { email, password: 'pass1234', displayName: '测试用户' } })
ok(reg.status === 200 && reg.data.token, '注册成功并返回 token', reg.data)
const token = reg.data.token

ok((await api('POST', '/api/auth/register', { body: { email, password: 'pass1234' } })).status === 409, '重复邮箱注册被拒绝')
ok((await api('POST', '/api/auth/login', { body: { email, password: 'wrong' } })).status === 401, '错误密码登录被拒绝')
ok((await api('POST', '/api/auth/login', { body: { email, password: 'pass1234' } })).status === 200, '正确密码登录通过')
ok((await api('GET', '/api/sync/pull')).status === 401, '无 token 访问私有接口被拒绝')

// 错误处理器如果注册晚于路由，子作用域就用不上它，客户端会收到 Fastify 的
// 英文默认消息（"Unauthorized"）而不是这里写的中文文案
const badLogin = await api('POST', '/api/auth/login', { body: { email, password: 'wrong' } })
ok(badLogin.data?.error === '邮箱或密码错误', '业务错误带中文文案传到客户端', badLogin.data)
const dupReg = await api('POST', '/api/auth/register', { body: { email, password: 'pass1234' } })
ok(dupReg.data?.error === '该邮箱已注册', '409 也带自定义文案', dupReg.data)

/* ---------- 2. 双设备 WS ---------- */
const dev1 = await openWs(token, 'dev1')
const dev2 = await openWs(token, 'dev2')
ok(await expectMsg(dev1.inbox, (m) => m.type === 'ready'), 'dev1 建立实时连接')
ok(await expectMsg(dev2.inbox, (m) => m.type === 'ready'), 'dev2 建立实时连接')

/* ---------- 3. 创建目录，另一端应实时收到 ---------- */
dev2.inbox.length = 0
const folder = (await api('POST', '/api/folders', { token, clientId: 'dev1', body: { name: '工作' } })).data
ok(folder?.id && folder.version === 1, '创建目录')
ok(await expectMsg(dev2.inbox, (m) => m.type === 'folder:upsert' && m.folder.id === folder.id), 'dev2 实时收到目录创建广播')
ok(!dev1.inbox.some((m) => m.type === 'folder:upsert'), 'dev1 作为发起方不收到自己的回声')

/* ---------- 4. 创建笔记 ---------- */
dev2.inbox.length = 0
const note = (await api('POST', '/api/notes', {
  token, clientId: 'dev1',
  body: { title: '会议纪要', content: '<h1>会议纪要</h1><p>正文</p>', excerpt: '正文' },
})).data
ok(note?.id && note.version === 1, '创建笔记')
ok(await expectMsg(dev2.inbox, (m) => m.type === 'note:upsert' && m.note.id === note.id), 'dev2 实时收到笔记创建广播')

/* ---------- 5. 保存 → 版本递增 ---------- */
dev2.inbox.length = 0
const saved = await api('PATCH', `/api/notes/${note.id}`, {
  token, clientId: 'dev1',
  body: { baseVersion: 1, content: '<h1>会议纪要</h1><p>更新后的正文</p>', title: '会议纪要' },
})
ok(saved.status === 200 && saved.data.version === 2, '基于正确版本保存，version 递增到 2')
const pushed = await expectMsg(dev2.inbox, (m) => m.type === 'note:upsert' && m.note.id === note.id)
ok(pushed?.note.content.includes('更新后的正文'), 'dev2 实时收到最新正文（正在浏览即热更新）')

/* ---------- 6. 版本冲突 ---------- */
const stale = await api('PATCH', `/api/notes/${note.id}`, {
  token, clientId: 'dev2',
  body: { baseVersion: 1, content: '<p>dev2 基于旧版本的改动</p>' },
})
ok(stale.status === 409 && stale.data.conflict === true, '基于过期版本保存返回 409 冲突')
ok(stale.data.note.version === 2 && stale.data.note.content.includes('更新后的正文'), '409 响应携带服务端最新版本，供客户端生成冲突副本')

const copy = (await api('POST', '/api/notes', {
  token, clientId: 'dev2',
  body: { title: '会议纪要（冲突副本）', content: '<p>dev2 基于旧版本的改动</p>', conflictOf: note.id },
})).data
ok(copy?.conflictOf === note.id, '冲突副本创建成功并回指原笔记')

/* ---------- 7. 拖拽归属 ---------- */
const moved = await api('PATCH', `/api/notes/${note.id}`, {
  token, clientId: 'dev1', body: { baseVersion: 2, folderId: folder.id },
})
ok(moved.status === 200 && moved.data.folderId === folder.id, '笔记拖拽到目录下（folderId 更新）')

const sub = (await api('POST', '/api/folders', { token, clientId: 'dev1', body: { name: '子目录', parentId: folder.id } })).data
ok(sub?.parentId === folder.id, '创建子目录')
const cycle = await api('PATCH', `/api/folders/${folder.id}`, { token, clientId: 'dev1', body: { parentId: sub.id } })
ok(cycle.status === 400, '拒绝把目录拖进自己的子目录（防环）')

/* ---------- 8. 增量拉取 ---------- */
const full = (await api('GET', '/api/sync/pull?since=0', { token })).data
ok(full.notes.length === 2 && full.folders.length === 2, '全量拉取返回 2 笔记 + 2 目录', full)
const cursor = full.seq
await api('PATCH', `/api/notes/${copy.id}`, { token, clientId: 'dev1', body: { baseVersion: 1, title: '改个名' } })
const delta = (await api('GET', `/api/sync/pull?since=${cursor}`, { token })).data
ok(delta.notes.length === 1 && delta.notes[0].id === copy.id, '增量拉取只返回游标之后的变更')

/* ---------- 9. 递归删除 ---------- */
dev2.inbox.length = 0
const del = await api('DELETE', `/api/folders/${folder.id}`, { token, clientId: 'dev1' })
ok(del.status === 200 && del.data.folders.length === 2, '删除目录时递归软删子目录')
ok(del.data.notes.some((n) => n.id === note.id), '目录下的笔记一并软删')
ok(await expectMsg(dev2.inbox, (m) => m.type === 'note:upsert' && m.note.id === note.id && m.note.deleted), 'dev2 实时收到删除广播')

const afterDel = (await api('GET', '/api/sync/pull?since=0', { token })).data
ok(afterDel.notes.find((n) => n.id === note.id)?.deleted === true, '软删后仍可拉取到（deleted 标记），保证多端能同步删除')

/* ---------- 10. 越权隔离 ---------- */
const other = (await api('POST', '/api/auth/register', { body: { email: `o${Date.now()}@test.local`, password: 'pass1234' } })).data
ok((await api('PATCH', `/api/notes/${copy.id}`, { token: other.token, body: { title: 'hack' } })).status === 404, '其他账号无法访问本账号笔记')

/* ---------- 11. 标签 ---------- */
const tagged = (await api('POST', '/api/notes', {
  token, clientId: 'dev1', body: { title: '带标签的笔记', tags: ['工作', '重要', '工作'] },
})).data
ok(JSON.stringify(tagged.tags) === '["工作","重要"]', '创建时带标签，重复的会去掉', tagged.tags)

const retagged = (await api('PATCH', `/api/notes/${tagged.id}`, {
  token, clientId: 'dev1', body: { tags: ['归档'], baseVersion: tagged.version },
})).data
ok(JSON.stringify(retagged.tags) === '["归档"]', '改标签')

const cleared = (await api('PATCH', `/api/notes/${tagged.id}`, {
  token, clientId: 'dev1', body: { title: '只改标题', baseVersion: retagged.version },
})).data
ok(JSON.stringify(cleared.tags) === '["归档"]', '不传 tags 时标签保持不变')

const junkTags = (await api('POST', '/api/notes', {
  token, clientId: 'dev1', body: { title: '脏标签', tags: ['  空白  ', '', null, 123, '正常'] },
})).data
ok(JSON.stringify(junkTags.tags) === '["空白","正常"]', '标签去空白、丢掉非字符串', junkTags.tags)

/* ---------- 12. 历史版本 ---------- */
const hist = (await api('POST', '/api/notes', {
  token, clientId: 'dev1', body: { title: '版本测试', content: '<p>第一版</p>' },
})).data
const h2 = (await api('PATCH', `/api/notes/${hist.id}`, {
  token, clientId: 'dev1', body: { content: '<p>第二版</p>', baseVersion: hist.version },
})).data
await api('PATCH', `/api/notes/${hist.id}`, {
  token, clientId: 'dev1', body: { content: '<p>第三版</p>', baseVersion: h2.version },
})

const revs = (await api('GET', `/api/notes/${hist.id}/revisions`, { token })).data
ok(revs.revisions.length === 1, '间隔内的连续修改只留一份快照，不会把历史刷满', revs.revisions.length)
ok(revs.revisions[0].title === '版本测试', '快照记下了当时的标题')

const revBody = (await api('GET', `/api/revisions/${revs.revisions[0].id}`, { token })).data
ok(revBody.content === '<p>第一版</p>', '快照存的是被覆盖掉的那一版内容', revBody.content)

const restored = (await api('POST', `/api/revisions/${revs.revisions[0].id}/restore`, { token, clientId: 'dev1' })).data
ok(restored.content === '<p>第一版</p>', '恢复到历史版本')
const afterRestore = (await api('GET', `/api/notes/${hist.id}/revisions`, { token })).data
ok(afterRestore.revisions.length === 2, '恢复动作本身也留了快照，所以恢复能再撤回')
ok(afterRestore.revisions[0].content === undefined, '版本列表不返回正文，避免列表接口过重')

ok((await api('GET', `/api/revisions/${revs.revisions[0].id}`, { token: other.token })).status === 404,
  '别人的历史版本读不到')

/* ---------- 13. 彻底删除 ---------- */
dev2.inbox.length = 0
const purgeTarget = (await api('POST', '/api/notes', { token, clientId: 'dev1', body: { title: '待彻底删除' } })).data
await api('DELETE', `/api/notes/${purgeTarget.id}`, { token, clientId: 'dev1' })
const purged = await api('DELETE', `/api/notes/${purgeTarget.id}/purge`, { token, clientId: 'dev1' })
ok(purged.status === 200, '彻底删除返回成功')
ok(await expectMsg(dev2.inbox, (m) => m.type === 'note:purged' && m.id === purgeTarget.id), 'dev2 收到彻底删除广播')
const afterPurge = (await api('GET', '/api/sync/pull?since=0', { token })).data
ok(!afterPurge.notes.some((n) => n.id === purgeTarget.id), '彻底删除后拉不到这条了，连墓碑都没有')
ok((await api('DELETE', `/api/notes/${purgeTarget.id}/purge`, { token })).status === 404, '重复彻底删除返回 404')

/* ---------- 14. 修改密码 ---------- */
ok((await api('POST', '/api/auth/password', { token, body: { oldPassword: '错的', newPassword: 'newpass123' } })).status === 401,
  '当前密码不对时拒绝改密码')
ok((await api('POST', '/api/auth/password', { token, body: { oldPassword: 'pass1234', newPassword: '123' } })).status === 400,
  '新密码太短被拒绝')
ok((await api('POST', '/api/auth/password', { token, body: { oldPassword: 'pass1234', newPassword: 'pass1234' } })).status === 400,
  '新密码不能与旧密码相同')
ok((await api('POST', '/api/auth/password', { token, body: { oldPassword: 'pass1234', newPassword: 'newpass123' } })).status === 200,
  '改密码成功')
ok((await api('POST', '/api/auth/login', { body: { email, password: 'pass1234' } })).status === 401, '旧密码失效')
ok((await api('POST', '/api/auth/login', { body: { email, password: 'newpass123' } })).status === 200, '新密码可登录')
ok((await api('GET', '/api/me', { token })).status === 200, '改密码后原有 token 仍然有效')

dev1.ws.close(); dev2.ws.close()
console.log('─'.repeat(46))
console.log(`  通过 ${pass}  失败 ${fail}\n`)
process.exit(fail ? 1 : 0)
