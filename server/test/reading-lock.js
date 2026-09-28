import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pbkdf2Sync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import Fastify from 'fastify'

const directory = mkdtempSync(join(tmpdir(), 'cloudnote-reading-lock-'))
process.env.CLOUDNOTE_DB = join(directory, 'test.sqlite')
process.env.CLOUDNOTE_SECRET = 'reading-lock-test-only-secret'
// 先建立不含阅读锁的新旧交界数据库，验证真实 ALTER TABLE 迁移保留原有数据。
const legacy = new DatabaseSync(process.env.CLOUDNOTE_DB)
legacy.exec(`
  CREATE TABLE notes (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, folder_id TEXT,
    title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',
    sort_order REAL NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, conflict_of TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE folders (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT,
    sort_order REAL NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO notes (id,user_id,title,content,seq,created_at,updated_at)
    VALUES ('legacy-note','legacy-user','已有笔记','旧正文',1,1,1);
  INSERT INTO folders (id,user_id,name,seq,created_at,updated_at)
    VALUES ('legacy-folder','legacy-user','已有目录',2,1,1);
`)
legacy.close()
const { default: routes } = await import('../src/routes.js')
const { db } = await import('../src/db.js')
const { join: joinHub } = await import('../src/hub.js')
const app = Fastify()
await app.register(routes)
await app.ready()
after(async () => {
  await app.close()
  db.close()
  for (const file of readdirSync(directory)) unlinkSync(join(directory, file))
  rmdirSync(directory)
})

const accountPassword = 'account-password-123'
async function request(method, url, token, payload) {
  const res = await app.inject({ method, url, headers: token ? {
    authorization: `Bearer ${token}`, 'x-client-id': 'origin',
  } : {}, ...(payload === undefined ? {} : { payload }) })
  return { status: res.statusCode, data: res.json(), headers: res.headers }
}
async function register(name) {
  return (await request('POST', '/api/auth/register', null,
    { email: `${name}@test.local`, password: accountPassword })).data
}

test('目录与笔记阅读密码：权限、同步、并发与恢复', async (t) => {
  const owner = await register('owner')
  const outsider = await register('outsider')
  const events = [], echoes = []
  const leave = joinHub(owner.user.id, 'peer', { readyState: 1, send: (raw) => events.push(JSON.parse(raw)) })
  const leaveOrigin = joinHub(owner.user.id, 'origin', { readyState: 1, send: (raw) => echoes.push(JSON.parse(raw)) })
  t.after(() => { leave(); leaveOrigin() })
  const folder = (await request('POST', '/api/folders', owner.token, { name: '私密目录' })).data
  const note = (await request('POST', '/api/notes', owner.token,
    { title: '私密笔记', folderId: folder.id, content: 'original' })).data
  const noteURL = `/api/notes/${note.id}/reading-lock`
  const folderURL = `/api/folders/${folder.id}/reading-lock`
  let locked, lockedFolder

  await t.test('旧实体默认无锁，数据库列已迁移', () => {
    assert.equal(note.readingLock, null)
    assert.equal(folder.readingLock, null)
    for (const table of ['notes', 'folders'])
      assert.ok(db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'reading_lock'))
    assert.equal(db.prepare('SELECT content FROM notes WHERE id=?').get('legacy-note').content, '旧正文')
    assert.equal(db.prepare('SELECT reading_lock FROM notes WHERE id=?').get('legacy-note').reading_lock, null)
    assert.equal(db.prepare('SELECT reading_lock FROM folders WHERE id=?').get('legacy-folder').reading_lock, null)
  })
  await t.test('无登录和其他账号均不能设置', async () => {
    const body = { password: 'secret-123', baseLockRevision: null }
    assert.equal((await request('PUT', noteURL, null, body)).status, 401)
    assert.equal((await request('PUT', noteURL, outsider.token, body)).status, 404)
    assert.equal((await request('PUT', folderURL, outsider.token, body)).status, 404)
  })
  await t.test('密码长度、类型及锁版本必填校验', async () => {
    for (const body of [
      {}, { password: 'secret-123' }, { password: 'short', baseLockRevision: null },
      { password: 'x'.repeat(129), baseLockRevision: null },
      { password: 123456, baseLockRevision: null },
      { password: 'secret-123', baseLockRevision: '' },
    ]) assert.equal((await request('PUT', noteURL, owner.token, body)).status, 400)
  })
  await t.test('首次设锁生成可离线验证的 PBKDF2 元数据并广播', async () => {
    events.length = 0; echoes.length = 0
    const response = await request('PUT', noteURL, owner.token, { password: 'secret-123', baseLockRevision: null })
    assert.equal(response.status, 200)
    locked = response.data
    const lock = locked.readingLock
    assert.match(lock.salt, /^[0-9a-f]{32}$/)
    assert.match(lock.hash, /^[0-9a-f]{64}$/)
    assert.equal(lock.iterations, 210000)
    assert.equal(pbkdf2Sync('secret-123', Buffer.from(lock.salt, 'hex'), lock.iterations, 32, 'sha256').toString('hex'), lock.hash)
    assert.equal(locked.version, note.version + 1)
    assert.ok(locked.seq > note.seq)
    assert.equal(events.at(-1).note.readingLock.revision, lock.revision)
    assert.equal(echoes.length, 0)
    assert.ok(!db.prepare('SELECT reading_lock FROM notes WHERE id=?').get(note.id).reading_lock.includes('secret-123'))
  })
  await t.test('目录设锁同步字段一致', async () => {
    lockedFolder = (await request('PUT', folderURL, owner.token, { password: 'folder-123', baseLockRevision: null })).data
    assert.equal(lockedFolder.version, 2)
    assert.equal(events.at(-1).folder.readingLock.revision, lockedFolder.readingLock.revision)
    const pull = (await request('GET', `/api/sync/pull?since=${note.seq}`, owner.token)).data
    assert.deepEqual(pull.notes.find((n) => n.id === note.id).readingLock, locked.readingLock)
    assert.deepEqual(pull.folders.find((f) => f.id === folder.id).readingLock, lockedFolder.readingLock)
  })
  await t.test('普通新增/编辑拒绝绕过专用锁接口', async () => {
    for (const entity of ['notes', 'folders']) {
      const id = entity === 'notes' ? note.id : folder.id
      for (const field of ['readingLock', 'reading_lock', 'password', 'accountPassword', 'baseLockRevision']) {
        assert.equal((await request('POST', `/api/${entity}`, owner.token, { [field]: null })).status, 400)
        assert.equal((await request('PATCH', `/api/${entity}/${id}`, owner.token, { [field]: null })).status, 400)
      }
    }
  })
  await t.test('旧正文版本冲突带回最新锁，正常正文写入不会清锁', async () => {
    const stale = await request('PATCH', `/api/notes/${note.id}`, owner.token, { baseVersion: 1, content: 'bad' })
    assert.equal(stale.status, 409)
    assert.deepEqual(stale.data.note.readingLock, locked.readingLock)
    const saved = await request('PATCH', `/api/notes/${note.id}`, owner.token, { baseVersion: locked.version, content: 'new content' })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.data.readingLock, locked.readingLock)
    locked = saved.data
  })
  await t.test('重设和取消需要账号密码；错误为 403 且登录仍有效', async () => {
    for (const password of [null, 'new-secret-123']) {
      const denied = await request('PUT', noteURL, owner.token,
        { password, baseLockRevision: locked.readingLock.revision, accountPassword: 'wrong' })
      assert.equal(denied.status, 403)
    }
    assert.equal((await request('GET', '/api/me', owner.token)).status, 200)
  })
  await t.test('冲突副本继承独立密码和当前目录，禁止跨账号来源', async () => {
    const copy = await request('POST', '/api/notes', owner.token, { conflictOf: note.id, folderId: null, content: 'draft' })
    assert.equal(copy.status, 200)
    assert.equal(copy.data.folderId, folder.id)
    assert.deepEqual(copy.data.readingLock, locked.readingLock)
    assert.equal((await request('POST', '/api/notes', outsider.token, { conflictOf: note.id })).status, 404)
  })
  await t.test('同时重设只有一次成功，过期锁版本返回 409', async () => {
    const results = await Promise.all(['new-secret-1', 'new-secret-2'].map((password) =>
      request('PUT', noteURL, owner.token, { password, accountPassword, baseLockRevision: locked.readingLock.revision })))
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
    const updated = results.find((r) => r.status === 200).data
    assert.notEqual(updated.readingLock.revision, locked.readingLock.revision)
    assert.notEqual(updated.readingLock.salt, locked.readingLock.salt)
    locked = updated
  })
  await t.test('恢复历史保留当前锁，软删除与恢复也保留', async () => {
    const revisions = (await request('GET', `/api/notes/${note.id}/revisions`, owner.token)).data.revisions
    assert.ok(revisions.length)
    const restored = await request('POST', `/api/revisions/${revisions[0].id}/restore`, owner.token, {})
    assert.deepEqual(restored.data.readingLock, locked.readingLock)
    const deleted = await request('DELETE', `/api/notes/${note.id}`, owner.token)
    assert.deepEqual(deleted.data.readingLock, locked.readingLock)
    const undeleted = await request('PATCH', `/api/notes/${note.id}`, owner.token, { deleted: false })
    assert.deepEqual(undeleted.data.readingLock, locked.readingLock)
    locked = undeleted.data
  })
  await t.test('正确账号密码取消目录/笔记密码并推送 null', async () => {
    for (const [url, current] of [[noteURL, locked], [folderURL, lockedFolder]]) {
      const cleared = await request('PUT', url, owner.token,
        { password: null, accountPassword, baseLockRevision: current.readingLock.revision })
      assert.equal(cleared.status, 200)
      assert.equal(cleared.data.readingLock, null)
      assert.equal(cleared.data.version, current.version + 1)
    }
    assert.equal(events.at(-1).folder.readingLock, null)
  })
  await t.test('连续错误账号密码触发 429 并返回重试等待', async () => {
    const victim = await register('rate-limit')
    const target = (await request('POST', '/api/notes', victim.token, {})).data
    const url = `/api/notes/${target.id}/reading-lock`
    const initialized = (await request('PUT', url, victim.token, { password: 'secret-123', baseLockRevision: null })).data
    const body = { password: null, accountPassword: 'wrong', baseLockRevision: initialized.readingLock.revision }
    for (let i = 0; i < 5; i++) assert.equal((await request('PUT', url, victim.token, body)).status, 403)
    const blocked = await request('PUT', url, victim.token, body)
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers['retry-after']) > 0)
  })
})
