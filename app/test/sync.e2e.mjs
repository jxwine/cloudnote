/**
 * 保存 / 同步的端到端回归。
 *
 * 用两个真实浏览器窗口当两台设备，真实键盘输入、真实断网。
 * 这里每一个场景都对应一个**真出过的 bug**，不是想象出来的用例。
 *
 * 跑：  npm --prefix app run test:sync          （看得见窗口）
 *       npm --prefix app run test:sync -- --headless
 * 前置：npm --prefix app run build
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync, readdirSync } from 'node:fs'
import { bootEnv, shutdown } from './harness.mjs'
import { sleep, reattach } from './cdp.mjs'
import * as ui from './app.mjs'
import * as inv from './invariants.mjs'

// 每次跑用自己的子目录：上一轮如果有 Chrome 没退干净，它会一直占着 profile，
// 复用同一个目录就会 EPERM 删不掉，测试还没开始就挂了
const TMP_ROOT = join(tmpdir(), 'cloudnote-sync-e2e')
const TMP = join(TMP_ROOT, String(process.pid))
const PASSWORD = 'test123456'

const results = []
let env
let accountSeq = 0

/**
 * 每个场景一套全新的账号。
 *
 * 只清 localStorage 是不够的——服务端库是整套环境共用的，上一个场景的笔记会被
 * pull 回来混进断言里，连「打开第 0 篇」都会开错笔记。换账号最省事，
 * 数据天然隔离，也不用为每个场景重启服务。
 */
let lastEmail = ''

async function freshPair(count = 2) {
  const email = `sync-e2e-${++accountSeq}@test.local`
  lastEmail = email
  await env.register(email, PASSWORD, `测试${accountSeq}`)

  const labels = ['A', 'B', 'C'].slice(0, count)
  const first = []
  for (const l of labels) {
    const d = await env.device(l)
    await ui.login(d, email, PASSWORD)
    await d.reload()
    first.push([l, d])
  }
  await sleep(3000)
  const ready = []
  for (const [l, d] of first) {
    const fresh = await reattach(d, { urlPart: '5273', name: `设备${l}` })
    await ui.waitReady(fresh)
    await ui.spyToasts(fresh)
    ready.push(fresh)
  }
  return ready
}

async function scenario(title, fn) {
  process.stdout.write(`\n▸ ${title}\n`)
  const checks = []
  const expect = (name, res) => {
    checks.push({ name, ...res })
    process.stdout.write(`    ${res.ok ? '✓' : '✗'} ${name}${res.ok ? '' : '\n        ' + res.why}\n`)
  }
  try {
    await fn(expect)
  } catch (err) {
    checks.push({ name: '场景执行', ok: false, why: String(err.message || err) })
    process.stdout.write(`    ✗ 场景执行出错\n        ${err.message || err}\n`)
  }
  results.push({ title, checks })
}

/* ------------------------------------------------------------------ */

async function main() {
  // 顺手收拾以前留下的，删不掉就算了，不影响这次
  try {
    for (const d of readdirSync(TMP_ROOT)) {
      try {
        rmSync(join(TMP_ROOT, d), { recursive: true, force: true })
      } catch {
        /* 还被占着，下次再说 */
      }
    }
  } catch {
    /* 第一次跑，根目录还不存在 */
  }
  env = await bootEnv({ tmpDir: TMP })

  // ---------------------------------------------------------------
  await scenario('归档冲突副本的请求失败时，也不许吃掉对方的内容', async (expect) => {
    const [A, B] = await freshPair()
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('归档失败基线')
    await ui.waitSynced(A)

    await ui.openNoteAt(B, 0)
    await sleep(1500)

    await A.offline(true)
    await sleep(400)
    await ui.focusBody(A)
    await A.type('[A断网时写的]')
    await sleep(2000)

    await ui.focusBody(B)
    await B.type('[B在线写的]')
    await ui.waitSynced(B)

    // 关键：网络恢复了，但「建冲突副本」这个请求头两次会失败。
    // 旧写法是先收下远端版本号再归档，归档一失败，本地就攥着一个借来的新版本号，
    // 下次保存服务端判不出冲突，B 写的东西就被无声无息地覆盖了。
    const restore = await A.failRequests({ method: 'POST', urlIncludes: '/api/notes', times: 2 })
    await A.offline(false)
    await A.evaluate(() => {
      document.querySelector('.sync-chip').click()
      return 1
    })
    await sleep(6000)
    await restore()

    // 放开之后再给它一次机会把该归档的归档掉
    await A.evaluate(() => {
      document.querySelector('.sync-chip').click()
      return 1
    })
    await sleep(8000)

    const all = await ui.notes(A)
    expect('两边的内容都还在', inv.contentNeverLost(all, ['[A断网时写的]', '[B在线写的]']))
    expect('和服务端对得上', inv.matchesServer(all, await ui.serverNotes(A)))
  })

  // ---------------------------------------------------------------
  await scenario('断网继续写，另一台改了同一篇，恢复网络后不许吃掉对方的内容', async (expect) => {
    const [A, B] = await freshPair()
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('共同基线')
    await ui.waitSynced(A)

    await ui.openNoteAt(B, 0)
    await sleep(1500)

    await A.offline(true)
    await sleep(400)
    await ui.focusBody(A)
    await A.type('[A断网时写的]')
    await sleep(2000)

    await ui.focusBody(B)
    await B.type('[B在线写的]')
    await ui.waitSynced(B)

    await A.offline(false)
    await A.evaluate(() => {
      document.querySelector('.sync-chip').click()
      return 1
    })
    await sleep(8000)

    const all = await ui.notes(A)
    expect('两边的内容都还在', inv.contentNeverLost(all, ['[A断网时写的]', '[B在线写的]']))
    expect('没有重复副本', inv.noDuplicateCopies(all))
    expect('两端收敛一致', inv.devicesConverge(all, await ui.notes(B)))
    expect('和服务端对得上', inv.matchesServer(all, await ui.serverNotes(A)))
  })

  // ---------------------------------------------------------------
  await scenario('两台设备同时改同一篇，输的那一端必须被告知', async (expect) => {
    const [A, B] = await freshPair()
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('同时编辑基线')
    await ui.waitSynced(A)

    await ui.openNoteAt(B, 0)
    await sleep(1500)
    await ui.clearToasts(A)
    await ui.clearToasts(B)

    await ui.focusBody(A)
    await ui.focusBody(B)
    await Promise.all([A.type('<<A的内容>>'), B.type('<<B的内容>>')])
    await sleep(8000)

    const all = await ui.notes(A)
    expect('两边的内容都还在', inv.contentNeverLost(all, ['<<A的内容>>', '<<B的内容>>']))
    expect('没有重复副本', inv.noDuplicateCopies(all))

    // 正文里留下谁的内容，谁就是「赢」的那端；另一端必须收到告知
    const aText = await ui.body(A)
    const loser = aText.includes('<<A的内容>>') ? B : A
    expect(
      `被顶掉的那端（设备${loser.name.slice(-1)}）收到了提示`,
      inv.overwriteAlwaysTold({
        noticeCount: await ui.noticeCount(loser),
        toasts: await ui.toasts(loser),
      })
    )
    expect('两端收敛一致', inv.devicesConverge(all, await ui.notes(B)))
  })

  // ---------------------------------------------------------------
  await scenario('只写正文不填标题就关掉，重开后标题要结算好', async (expect) => {
    const [A] = await freshPair()
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('这一行应该成为标题')
    await sleep(2500)

    await A.reload()
    await sleep(5000)
    const A2 = await reattach(A, { urlPart: '5273', name: '设备A' })
    await ui.waitReady(A2)

    const side = await ui.sidebar(A2)
    expect('标题结算了，不是「无标题」', {
      ok: side.includes('这一行应该成为标题'),
      why: `侧栏里是：${JSON.stringify(side)}`,
    })
    const all = await ui.notes(A2)
    expect('正文没丢', inv.contentNeverLost(all, ['这一行应该成为标题']))
    expect('没有平白多出副本', inv.noDuplicateCopies(all))
    expect('没有内容相同的多余副本', {
      ok: all.filter((n) => n.isConflictCopy).length === 0,
      why: `多出了 ${all.filter((n) => n.isConflictCopy).length} 条冲突副本，关窗不该产生冲突`,
    })
  })

  // ---------------------------------------------------------------
  await scenario('慢网络下连续快打，一个字都不许掉', async (expect) => {
    const [A, B] = await freshPair()
    await A.slowNetwork(300) // 把本地 0ms RTT 撑开，逼出竞态
    await ui.newNote(A)
    await sleep(1500)
    await ui.focusBody(A)

    // 一直不停手，跨过 SAVE_MAX_WAIT，中途会被强制落库好几次
    const marks = []
    for (let i = 1; i <= 8; i++) {
      const m = `#${i}#`
      marks.push(m)
      await A.type(m)
      await sleep(900)
    }
    await A.slowNetwork(0)
    await ui.waitSynced(A, 30000)
    await sleep(2500)

    const all = await ui.notes(A)
    expect('每一段都在', inv.contentNeverLost(all, marks))
    expect('和服务端对得上', inv.matchesServer(all, await ui.serverNotes(A)))
    expect('另一端也收到了', inv.contentNeverLost(await ui.notes(B), marks))
  })

  await scenario('登录失效后继续写，内容不许丢，还要告诉用户', async (expect) => {
    const [A] = await freshPair()
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('失效前写的')
    await ui.waitSynced(A)

    // token 作废（过期、换密钥、账号被停用，服务端一律 401）
    await ui.breakToken(A)

    // 用户毫不知情地继续写，每次落库都会 401
    for (let i = 1; i <= 5; i++) {
      await ui.focusBody(A)
      await A.type(`[失效后第${i}段]`)
      await sleep(1300)
    }
    await sleep(3000)

    const marks = [1, 2, 3, 4, 5].map((i) => `[失效后第${i}段]`)

    expect('明确告诉用户要重新登录', {
      ok: (await ui.authDialogText(A)).includes('重新登录'),
      why: '既没有弹窗也没有提示，用户只会看到状态栏一个红点，以为是网不好',
    })
    expect('提示里说清楚了改动还在', {
      ok: (await ui.authDialogText(A)).includes('没有丢'),
      why: '用户第一反应是「我刚写的东西是不是没了」，这句必须有',
    })

    // 最要命的一步：切走再切回来，编辑器会用 store 里的内容重置
    await ui.newNote(A)
    await sleep(1500)
    await ui.openNoteAt(A, 0)
    await sleep(2000)

    expect('切走再切回来，失效后写的内容还在', inv.contentNeverLost(await ui.notes(A), marks))
    expect('待发队列还留着，没被清掉', {
      ok: await A.evaluate(() => !!localStorage.getItem('cloudnote.pending')),
      why: 'localStorage 里的待发改动被清了，重新登录也补不回来',
    })
  })

  await scenario('重新登录后，失效期间写的东西要自动补传上去', async (expect) => {
    const [A] = await freshPair()
    const email = lastEmail
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('补传前')
    await ui.waitSynced(A)

    await ui.breakToken(A)
    await ui.focusBody(A)
    await A.type('[失效期间写的]')
    await sleep(3500)

    // 用同一个账号点「重新登录」回来
    await A.evaluate(() => {
      const btn = [...document.querySelectorAll('.dialog button')].find((b) =>
        b.textContent.includes('重新登录')
      )
      if (!btn) throw new Error('没找到重新登录按钮')
      btn.click()
      return 'ok'
    })
    await sleep(1500)
    await ui.login(A, email, PASSWORD)
    await A.reload()
    await sleep(4000)
    const A2 = await reattach(A, { urlPart: '5273', name: '设备A' })
    await ui.waitReady(A2)
    await sleep(6000)

    const onServer = await ui.serverNotes(A2)
    expect('失效期间写的内容传到服务端了', {
      ok: onServer.some((n) => n.text.includes('[失效期间写的]')),
      why:
        '服务端上没有这段内容 —— 提示里承诺了「登回来会自动补传」，没做到就是骗人。服务端现有：' +
        onServer.map((n) => JSON.stringify(n.text.slice(0, 30))).join(' '),
    })
    expect('本地也还在', inv.contentNeverLost(await ui.notes(A2), ['[失效期间写的]']))
  })

  await scenario('新建笔记没能同步到云端时，刚打的字不许跟着消失', async (expect) => {
    const [A] = await freshPair(1)
    // 让创建请求失败：token 过期、服务端抖一下都会这样。
    // 原来这时会直接 dropLocal——笔记从侧栏消失、编辑区清空、一声不吭
    // 用 500 而不是网络失败：网络失败会被当成离线（本来就会入队重试），
    // 「把本地这篇扔掉」那条路只有服务端明确报错才走得到
    await ui.rejectInPage(A, { method: 'POST', urlEndsWith: '/api/notes', status: 500, times: 1 })
    await ui.newNote(A)
    await sleep(800)
    await ui.focusBody(A)
    await A.type('创建失败时敲进去的字')
    await sleep(2500)
    await ui.restoreFetch(A)

    expect('笔记还在侧栏里，没被扔掉', {
      ok: (await ui.sidebar(A)).length > 0 && (await ui.notes(A)).length > 0,
      why: `侧栏：${JSON.stringify(await ui.sidebar(A))}`,
    })
    expect('刚敲的字还在', inv.contentNeverLost(await ui.notes(A), ['创建失败时敲进去的字']))

    // 恢复后重连一次，内容应该补传上去
    await A.evaluate(() => {
      document.querySelector('.sync-chip').click()
      return 1
    })
    await sleep(8000)
    expect('恢复后补传到了服务端', {
      ok: (await ui.serverNotes(A)).some((n) => n.text.includes('创建失败时敲进去的字')),
      why: '服务端上没有，说明入队重放没把它补上去',
    })
  })

  // ---------------------------------------------------------------
  await scenario('打字的同时把笔记拖走 / 改标签，正文不许被退回去', async (expect) => {
    const [A] = await freshPair(1)
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('结构操作基线')
    await ui.waitSynced(A)

    // 把 RTT 撑开，制造出「PATCH 在路上时又干了别的」这个窗口
    await A.slowNetwork(400)
    await ui.focusBody(A)
    await A.type('[边打字边操作]')
    // 不等防抖结束就改标签：两个请求会撞在一起
    await A.evaluate(() => {
      const input = document.querySelector('.tag-input, .tagbar input')
      if (!input) return 'no-tagbar'
      return 'ok'
    })
    await sleep(300)
    await ui.renameViaSidebar(A, '打字时改的名字')
    await sleep(6000)
    await A.slowNetwork(0)
    await sleep(4000)

    const all = await ui.notes(A)
    expect('打的字没被退回去', inv.contentNeverLost(all, ['[边打字边操作]']))
    expect('没有平白冒出冲突副本', {
      ok: all.filter((n) => n.isConflictCopy).length === 0,
      why: `只有一台设备，却冒出了 ${all.filter((n) => n.isConflictCopy).length} 条「云端版本」副本`,
    })
    expect('和服务端对得上', inv.matchesServer(all, await ui.serverNotes(A)))
  })

  // ---------------------------------------------------------------
  await scenario('写着写着误删，从回收站恢复回来最后几句话要还在', async (expect) => {
    const [A] = await freshPair(1)
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('删除基线')
    await ui.waitSynced(A)

    // 刚敲完就删，这几个字还在防抖窗口里没落库
    await ui.focusBody(A)
    await A.type('[删之前最后写的]')
    // 不等防抖：这几个字此刻只在 pendingSaves 里，删除要是直接把它扔了就再也回不来
    await ui.deleteActiveNote(A)
    await sleep(5000)

    await ui.restoreFromTrash(A)
    await sleep(5000)

    const all = await ui.notes(A)
    expect('恢复回来最后几句话还在', inv.contentNeverLost(all, ['[删之前最后写的]']))
    expect('和服务端对得上', inv.matchesServer(all, await ui.serverNotes(A)))
  })

  // ---------------------------------------------------------------
  await scenario('三台设备：一台改，另外两台都要跟上且互相一致', async (expect) => {
    const [A, B, C] = await freshPair(3)
    await ui.newNote(A)
    await sleep(1200)
    await ui.focusBody(A)
    await A.type('三端基线')
    await ui.waitSynced(A)

    await ui.openNoteAt(B, 0)
    await ui.openNoteAt(C, 0)
    await sleep(2000)

    await ui.focusBody(A)
    await A.type('[A广播出去的]')
    await ui.waitSynced(A)
    await sleep(4000)

    expect('B 跟上了', {
      ok: (await ui.body(B)).includes('[A广播出去的]'),
      why: `B 看到的是：${JSON.stringify(await ui.body(B))}`,
    })
    expect('C 也跟上了', {
      ok: (await ui.body(C)).includes('[A广播出去的]'),
      why: `C 看到的是：${JSON.stringify(await ui.body(C))}`,
    })
    expect('A 和 B 一致', inv.devicesConverge(await ui.notes(A), await ui.notes(B)))
    expect('A 和 C 一致', inv.devicesConverge(await ui.notes(A), await ui.notes(C)))

    // 三台同时改同一篇：内容一个都不许丢
    await ui.clearToasts(A)
    await ui.clearToasts(B)
    await ui.clearToasts(C)
    await ui.focusBody(A)
    await ui.focusBody(B)
    await ui.focusBody(C)
    await Promise.all([A.type('{A三方}'), B.type('{B三方}'), C.type('{C三方}')])
    await sleep(12000)

    const finalA = await ui.notes(A)
    expect('三方的内容都还在', inv.contentNeverLost(finalA, ['{A三方}', '{B三方}', '{C三方}']))
    expect('没有重复副本', inv.noDuplicateCopies(finalA))
  })

  report()
}

function report() {
  const all = results.flatMap((r) => r.checks)
  const bad = all.filter((c) => !c.ok)
  process.stdout.write(`\n${'─'.repeat(64)}\n`)
  if (!bad.length) {
    process.stdout.write(`全部通过：${results.length} 个场景，${all.length} 项检查\n`)
  } else {
    process.stdout.write(`失败 ${bad.length} / ${all.length} 项：\n`)
    for (const r of results) {
      for (const c of r.checks) if (!c.ok) process.stdout.write(`  · ${r.title}\n    ${c.name}：${c.why}\n`)
    }
  }
  process.exitCode = bad.length ? 1 : 0
}

main()
  .catch((err) => {
    process.stdout.write(`\n环境起不来：${err.message}\n`)
    process.exitCode = 1
  })
  .finally(() => {
    shutdown()
    setTimeout(() => process.exit(process.exitCode ?? 0), 800)
  })
