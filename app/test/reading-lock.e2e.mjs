/** 阅读锁真实 UI 回归；独立数据库、独立无头浏览器，不复用用户浏览器。 */
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootEnv, shutdown } from './harness.mjs'
import { until, sleep } from './cdp.mjs'
import * as ui from './app.mjs'

if (!process.argv.includes('--headless')) process.argv.push('--headless')
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PASSWORD = 'account123456'
// 明确列出界面期望值，不在测试里复制生产脱敏算法。
const MASKED_TITLES = {
  '私人笔记': '私**记', '个人资料': '个**料', '账号文档': '账**档',
  '重要账号': '重**号', '已删除的私密目录': '已**录', '日记': '日*', '密': '*',
}
let dev, token
const checks = []
const pass = (name) => { checks.push(name); console.log(`PASS: ${name}`) }
const api = async (path, body, method = 'POST') => {
  const response = await fetch(`${ui.SERVER}/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}`, 'x-client-id': 'lock-e2e-other-device' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.json()
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`)
  return value
}
const exists = (selector) => dev.evaluate((s) => !!document.querySelector(s), selector)
const text = (selector) => dev.evaluate((s) => document.querySelector(s)?.textContent || '', selector)
const wait = (selector) => until(() => exists(selector), { what: selector })
const click = (selector) => dev.evaluate((s) => {
  const element = document.querySelector(s)
  if (!element) throw new Error(`找不到 ${s}`)
  element.click()
}, selector)
const clickText = (selector, label) => dev.evaluate((s, label) => {
  const element = [...document.querySelectorAll(s)].find((el) => el.textContent.trim() === label)
  if (!element) throw new Error(`找不到 ${s}: ${label}`)
  element.click()
}, selector, label)
const fill = async (selector, value) => {
  await dev.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error(s); el.focus(); el.select() }, selector)
  await dev.type(value)
}
const openRow = async (title) => {
  await until(() => dev.evaluate((t) => [...document.querySelectorAll('.tree-label')].some((el) => el.textContent === t), title), { what: `树节点 ${title}` })
  await dev.evaluate((t) => [...document.querySelectorAll('.tree-label')].find((el) => el.textContent === t).closest('.tree-row').click(), title)
}
const menu = async (title, action) => {
  await dev.evaluate((t) => {
    const row = [...document.querySelectorAll('.tree-label')].find((el) => el.textContent === t)?.closest('.tree-row')
    if (!row) throw new Error(`找不到 ${t}`)
    row.querySelector('[title="更多"]').click()
  }, title)
  await clickText('.menu-item', action)
}
const submit = async (selector) => { await dev.evaluate((s) => document.querySelector(s).requestSubmit(), selector); await sleep(150) }
const unlock = async (password, expectedBody) => {
  await wait('.reading-lock-form')
  await fill('.reading-lock-form input', password)
  await submit('.reading-lock-form')
  if (expectedBody) {
    await until(async () => (await ui.body(dev)).includes(expectedBody), { what: `解锁正文 ${expectedBody}` })
    const original = { PRIVATE_CONTENT: '私人笔记', NESTED_SECRET: '重要账号', RESTORED_SECRET: '恢复的秘密笔记', SHORT_SECRET: '日记' }[expectedBody]
    assert.equal(await dev.evaluate(() => document.querySelector('.note-title')?.value), original, '解锁后编辑器应恢复完整标题')
    if (await exists('.tree')) await assertTreeTitle(original, original)
  }
}
const assertTreeTitle = async (display, original) => {
  const row = await dev.evaluate((name) => {
    const el = [...document.querySelectorAll('.tree-label')].find((el) => el.textContent === name)?.closest('.tree-row')
    return el ? { text: el.querySelector('.tree-label').textContent, title: el.getAttribute('title') } : null
  }, display)
  assert.deepEqual(row, { text: display, title: display }, `树节点文本及悬停 title 应为 ${display}`)
  if (display !== original) assert.ok(!(await ui.sidebar(dev)).includes(original), '未解锁树中不得显示完整标题')
}
const locked = async (name) => {
  assert.ok(MASKED_TITLES[name], `请为 ${name} 指定明确脱敏期望值`)
  await until(async () => (await text('.reading-lock-form h1')) === MASKED_TITLES[name], { what: `脱敏锁页 ${MASKED_TITLES[name]}` })
  assert.equal(await exists('.ProseMirror'), false, '锁页不能挂载正文编辑器')
  assert.ok(!(await text('.reading-lock-pane')).includes(name), '未解锁页面不得显示完整名称')
  const exposedTooltips = await dev.evaluate((original) => [...document.querySelectorAll('[title]')].filter((el) => el.getAttribute('title').includes(original)).map((el) => el.getAttribute('title')), name)
  assert.deepEqual(exposedTooltips, [], '悬停 title 属性不得泄露锁定名称')
}
const dialogFill = async (values) => {
  await wait('.reading-lock-dialog')
  for (let i = 0; i < values.length; i++) await fill(`.reading-lock-dialog label:nth-of-type(${i + 1}) input`, values[i])
  await submit('.reading-lock-dialog')
}
const dialogDone = () => until(async () => !(await exists('.reading-lock-dialog')), { what: '密码弹框关闭' })
const shot = async (name) => {
  mkdirSync(join(root, 'tasks'), { recursive: true })
  const { data } = await dev.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(root, `tasks/${name}.png`), Buffer.from(data, 'base64'))
}

try {
  const env = await bootEnv({ tmpDir: join(tmpdir(), `cloudnote-reading-lock-${process.pid}`), browsers: 1 })
  await env.register('reading-lock@test.local', PASSWORD, '阅读锁测试')
  token = (await api('auth/login', { email: 'reading-lock@test.local', password: PASSWORD })).token
  const publicNote = await api('notes', { title: '公开笔记', content: '<p>PUBLIC_CONTENT</p>' })
  let secret = await api('notes', { title: '私人笔记', content: '<h1>隐私标题</h1><p>PRIVATE_CONTENT</p>', excerpt: 'PRIVATE_CONTENT' })
  let outer = await api('folders', { name: '个人资料' })
  let inner = await api('folders', { name: '账号文档', parentId: outer.id })
  let nested = await api('notes', { title: '重要账号', folderId: inner.id, content: '<p>NESTED_SECRET</p>', excerpt: 'NESTED_SECRET' })
  for (const [plural, entity, password] of [['folders', outer, 'outer123'], ['folders', inner, 'inner123'], ['notes', nested, 'nested123']]) {
    const result = await api(`${plural}/${entity.id}/reading-lock`, { password, baseLockRevision: null }, 'PUT')
    if (plural === 'folders' && entity.id === outer.id) outer = result
    else if (plural === 'folders') inner = result
    else nested = result
  }
  dev = await env.device('A')
  await ui.login(dev, 'reading-lock@test.local', PASSWORD)
  await ui.waitReady(dev)
  await openRow('私人笔记')
  await until(async () => (await ui.body(dev)).includes('PRIVATE_CONTENT'), { what: '初始正文' })
  await menu('私人笔记', '设置阅读密码')
  await dialogFill(['private123', 'private123'])
  await dialogDone()
  await locked('私人笔记')
  await assertTreeTitle('私**记', '私人笔记')
  pass('真实桌面菜单设置密码后立即隐藏正文，树标题及悬停提示脱敏')
  await unlock('wrong123')
  await until(async () => (await text('.reading-lock-error')).includes('不正确'), { what: '错误密码反馈' })
  await locked('私人笔记')
  await unlock('private123', 'PRIVATE_CONTENT')
  pass('错误密码拒绝，正确密码解锁')
  await openRow('公开笔记')
  await openRow('私**记')
  await locked('私人笔记')
  pass('切换到其他笔记后自动重新锁定')
  await clickText('.reading-lock-links button', '取消密码')
  assert.equal(await dev.evaluate(() => document.querySelectorAll('.reading-lock-dialog input').length), 1)
  await dialogFill(['bad-account-password'])
  await until(async () => !!(await text('.reading-lock-dialog .reading-lock-error')), { what: '账号密码拒绝' })
  await dialogFill([PASSWORD])
  await dialogDone()
  await until(async () => (await ui.body(dev)).includes('PRIVATE_CONTENT'), { what: '取消密码后正文' })
  pass('取消密码必须验证账号密码，错误账号密码不能取消')
  await menu('私人笔记', '设置阅读密码')
  await dialogFill(['private123', 'private123'])
  await dialogDone()
  await locked('私人笔记')
  await clickText('.reading-lock-links button', '忘记密码')
  assert.equal(await dev.evaluate(() => document.querySelectorAll('.reading-lock-dialog input').length), 3)
  await dialogFill(['bad-account-password', 'reset123', 'reset123'])
  await until(async () => !!(await text('.reading-lock-dialog .reading-lock-error')), { what: '重设账号密码拒绝' })
  await dialogFill([PASSWORD, 'reset123', 'reset123'])
  await dialogDone()
  await locked('私人笔记')
  await unlock('private123')
  await until(async () => (await text('.reading-lock-error')).includes('不正确'), { what: '旧密码失效' })
  await unlock('reset123', 'PRIVATE_CONTENT')
  pass('忘记密码验证账号后重设，旧密码失效且新密码可用')
  await openRow('公开笔记')
  await openRow('私**记')
  await dev.offline(true)
  await unlock('reset123', 'PRIVATE_CONTENT')
  await dev.offline(false)
  await ui.waitReady(dev)
  pass('已同步阅读锁支持离线验证解锁')
  secret = (await api('sync/pull?since=0', undefined, 'GET')).notes.find((n) => n.id === secret.id)
  secret = await api(`notes/${secret.id}/reading-lock`, { password: 'remote123', accountPassword: PASSWORD, baseLockRevision: secret.readingLock.revision }, 'PUT')
  await locked('私人笔记')
  await unlock('reset123')
  await until(async () => (await text('.reading-lock-error')).includes('不正确'), { what: '同步旧密码失效' })
  await unlock('remote123', 'PRIVATE_CONTENT')
  pass('另一设备接口改锁通过实时同步使当前授权立即失效')
  const otherTab = await dev.send('Target.createTarget', { url: 'about:blank', background: false })
  try {
    await dev.send('Target.activateTarget', { targetId: otherTab.targetId })
    await locked('私人笔记')
  } finally {
    await dev.send('Target.closeTarget', { targetId: otherTab.targetId })
    await dev.send('Page.bringToFront', {})
  }
  await unlock('remote123', 'PRIVATE_CONTENT')
  pass('浏览器实际切换标签触发失焦后重新锁定，返回可再次解锁')
  await openRow('个**料')
  await locked('个人资料')
  assert.ok(!(await ui.sidebar(dev)).includes('账号文档'), '未解锁父目录不能展示子目录')
  await assertTreeTitle('个**料', '个人资料')
  await shot('reading-lock-desktop')
  await dev.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await until(() => dev.evaluate(() => document.documentElement.dataset.theme === 'dark'), { what: '桌面深色主题' })
  await shot('reading-lock-dark')
  await dev.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await unlock('outer123')
  await assertTreeTitle('个人资料', '个人资料')
  await openRow('账**档')
  await locked('账号文档')
  await unlock('inner123')
  await assertTreeTitle('账号文档', '账号文档')
  await openRow('重**号')
  await locked('重要账号')
  await unlock('nested123', 'NESTED_SECRET')
  pass('父目录、子目录、独立笔记分别逐层解锁')
  await openRow('公开笔记')
  assert.ok(!(await ui.sidebar(dev)).includes('重要账号'), '离开范围后锁目录必须收起')
  await openRow('个**料')
  await locked('个人资料')
  pass('离开多层保护范围后所有子级自动隐藏并重新锁定')
  await openRow('私**记')
  await unlock('remote123', 'PRIVATE_CONTENT')
  await menu('私人笔记', '删除笔记')
  await until(async () => !(await ui.sidebar(dev)).includes('私人笔记'), { what: '删除受保护笔记' })
  await ui.waitSynced(dev)
  await dev.reload()
  await ui.waitReady(dev)
  await click('.titlebar [title^="回收站"]')
  await until(async () => (await text('.is-trash')).includes('受密码保护的笔记'), { what: '回收站锁定占位' })
  const trashText = await text('.is-trash')
  assert.ok(!trashText.includes('私人笔记') && !trashText.includes('PRIVATE_CONTENT'), '回收站锁定项不能泄露标题或摘要')
  assert.ok(!trashText.includes('放回去') && !trashText.includes('彻底删除'), '锁定项必须先解锁才能管理')
  await clickText('.trash-actions button', '解锁后管理')
  await wait('[aria-label="解锁回收站笔记"]')
  await unlock('remote123')
  await until(async () => !(await exists('[aria-label="解锁回收站笔记"]')), { what: '回收站解锁弹框关闭' })
  assert.ok((await text('.is-trash')).includes('私人笔记'))
  await clickText('.trash-actions button', '放回去')
  await until(async () => !(await exists('.is-trash')), { what: '恢复受保护笔记' })
  pass('带锁笔记删除并刷新后只显占位，输入阅读密码后可恢复')
  await click('.titlebar [title^="回收站"]')
  await openRow('私**记')
  if (await exists('.reading-lock-form')) await unlock('remote123', 'PRIVATE_CONTENT')
  await menu('私人笔记', '删除笔记')
  await ui.waitSynced(dev)
  await dev.reload()
  await ui.waitReady(dev)
  await click('.titlebar [title^="回收站"]')
  await clickText('.trash-actions button', '解锁后管理')
  await wait('[aria-label="解锁回收站笔记"]')
  await clickText('.reading-lock-links button', '忘记密码')
  await dialogFill([PASSWORD, 'trashreset123', 'trashreset123'])
  await dialogDone()
  await wait('[aria-label="解锁回收站笔记"] .reading-lock-form')
  await unlock('trashreset123')
  await until(async () => !(await exists('[aria-label="解锁回收站笔记"]')), { what: '重设后解锁回收站笔记' })
  await clickText('.trash-actions button', '放回去')
  await until(async () => !(await exists('.is-trash')), { what: '重设后恢复受保护笔记' })
  pass('回收站解锁弹框支持忘记密码、账号验证重设及恢复')
  await click('.titlebar [title^="回收站"]')
  await dev.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await dev.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await dev.send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] })
  await dev.reload()
  await ui.waitReady(dev)
  await wait('.m-home')
  assert.ok(!(await text('.m-home')).includes('NESTED_SECRET'))
  assert.ok(!(await text('.m-home')).includes('PRIVATE_CONTENT'))
  assert.ok(!(await text('.m-home')).includes('私人笔记'), '手机锁定卡片不能显示完整标题')
  assert.ok((await text('.m-home')).includes('私**记'), '手机锁定卡片必须显示明确脱敏标题')
  await click('.m-top [aria-label="目录"]')
  await wait('.m-sheet')
  assert.ok(!(await text('.m-sheet')).includes('账号文档'))
  assert.ok(!(await text('.m-sheet')).includes('个人资料'), '手机目录面板不得暴露完整锁定目录名')
  assert.ok((await text('.m-sheet')).includes('个**料'))
  await dev.evaluate(() => [...document.querySelectorAll('.m-sheet-main')].find((el) => el.querySelector('.m-sheet-label')?.textContent === '个**料').click())
  await locked('个人资料')
  assert.equal((await text('.m-title')).trim(), '个**料', '手机目录页顶部标题必须脱敏')
  const geometry = await dev.evaluate(() => {
    const r = document.querySelector('.reading-lock-form').getBoundingClientRect()
    return { width: innerWidth, overflow: document.documentElement.scrollWidth, left: r.left, right: r.right }
  })
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.overflow <= geometry.width, JSON.stringify(geometry))
  await shot('reading-lock-mobile')
  await unlock('outer123')
  await until(async () => !(await exists('.reading-lock-form')), { what: '手机目录解锁' })
  assert.equal((await text('.m-title')).trim(), '个人资料', '手机目录解锁后恢复完整标题')
  await click('.m-top [aria-label="返回"]')
  await click('.m-top [aria-label="目录"]')
  await dev.evaluate(() => [...document.querySelectorAll('.m-sheet-main')].find((el) => el.querySelector('.m-sheet-label')?.textContent === '个**料').click())
  await locked('个人资料')
  pass('390px 手机目录入口、锁定摘要保护、无横向溢出、返回后重锁')
  await click('.m-top [aria-label="返回"]')
  const archivedFolder = await api('folders', { name: '已删除的私密目录' })
  await api(`folders/${archivedFolder.id}/reading-lock`, { password: 'archived123', baseLockRevision: null }, 'PUT')
  const restoredNote = await api('notes', { title: '恢复的秘密笔记', folderId: archivedFolder.id, content: '<p>RESTORED_SECRET</p>', excerpt: 'RESTORED_SECRET' })
  await api(`folders/${archivedFolder.id}`, undefined, 'DELETE')
  const deletedNote = (await api('sync/pull?since=0', undefined, 'GET')).notes.find((n) => n.id === restoredNote.id)
  await api(`notes/${restoredNote.id}`, { deleted: false, baseVersion: deletedNote.version }, 'PATCH')
  await until(async () => (await text('.m-home')).includes('受密码保护的笔记'), { what: '已删除祖先目录下恢复笔记的匿名入口' })
  assert.ok(!(await text('.m-home')).includes('恢复的秘密笔记') && !(await text('.m-home')).includes('RESTORED_SECRET'), '匿名入口不能暴露标题或摘要')
  await dev.evaluate(() => [...document.querySelectorAll('.m-card')].find((el) => el.textContent.includes('受密码保护的笔记')).click())
  await locked('已删除的私密目录')
  await unlock('archived123', 'RESTORED_SECRET')
  await click('.m-top [aria-label="返回"]')
  await wait('.m-home')
  assert.ok((await text('.m-home')).includes('受密码保护的笔记'))
  assert.ok(!(await text('.m-home')).includes('恢复的秘密笔记'))
  pass('已删除祖先目录中的单独恢复笔记保留匿名入口，验证目录密码可读且返回重锁')
  console.log(JSON.stringify({ passed: checks.length, checks, screenshots: ['tasks/reading-lock-desktop.png', 'tasks/reading-lock-dark.png', 'tasks/reading-lock-mobile.png'] }, null, 2))
} catch (error) {
  if (dev) {
    console.error('页面状态：', await dev.evaluate(() => document.body.innerText).catch(() => '不可读'))
    await shot('reading-lock-failure').catch(() => {})
  }
  throw error
} finally {
  dev?.close()
  await shutdown()
}
