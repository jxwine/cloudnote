/**
 * 同步逻辑必须守住的几条底线。
 *
 * 这些不是「某个场景的期望输出」，而是**任何路径下都不许破**的规则。
 * 场景会越写越多，规则就这几条——新场景只要跑一遍这里的检查，
 * 就能挡住「换个操作顺序又开始丢字」这类回归。
 */

/**
 * 底线一：用户敲进去的东西不许凭空消失。
 *
 * 允许它在主笔记正文里，也允许它被挪进冲突副本（多端同时改时这是设计行为），
 * 但不允许两头都找不到。这是这个应用最不能破的一条——笔记软件丢字，
 * 别的做得再好也没意义。
 */
export function contentNeverLost(all, fragments) {
  const missing = []
  for (const frag of fragments) {
    const hit = all.some((n) => n.text.includes(frag))
    if (!hit) missing.push(frag)
  }
  if (missing.length) {
    return {
      ok: false,
      why:
        `这些内容在主笔记和所有冲突副本里都找不到：${missing.map((m) => `「${m}」`).join('、')}\n` +
        `        当前有 ${all.length} 篇：` +
        all.map((n) => `${n.isConflictCopy ? '[副本]' : '[正本]'}${JSON.stringify(n.text.slice(0, 40))}`).join(' '),
    }
  }
  return { ok: true }
}

/**
 * 底线二：内容被别人的版本顶掉时，本端必须收到告知。
 *
 * 不要求一定是哪种形式——编辑区的横幅（notice）或者 toast 都算。
 * 用户可以接受「你的版本被存到别处了」，不能接受字没了还不知道。
 */
export function overwriteAlwaysTold({ noticeCount, toasts }) {
  if (noticeCount > 0 || toasts.length > 0) return { ok: true }
  return {
    ok: false,
    why: '本端正文被远端内容替换了，但既没有冲突横幅也没有 toast，用户无从得知',
  }
}

/**
 * 底线三：不许出现内容一模一样的重复冲突副本。
 *
 * 副本是用来留住「不一样的那一版」的。两条一模一样的副本只是噪音，
 * 还会让用户以为自己丢了两次东西。
 */
export function noDuplicateCopies(all) {
  const copies = all.filter((n) => n.isConflictCopy)
  const seen = new Map()
  for (const c of copies) {
    const key = c.text.trim()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1)
  if (dup.length) {
    return {
      ok: false,
      why: dup.map(([t, n]) => `内容「${t.slice(0, 30)}」有 ${n} 条一样的副本`).join('；'),
    }
  }
  return { ok: true }
}

/**
 * 底线四：各端最终看到的东西要一致。
 *
 * 允许中间过程不同步，但尘埃落定后两端的笔记集合必须收敛，
 * 否则就是「我这台有、你那台没有」的分裂状态。
 */
export function devicesConverge(a, b) {
  const norm = (list) =>
    list
      .map((n) => n.text.trim())
      .sort()
      .join(' | ')
  if (norm(a) === norm(b)) return { ok: true }
  return {
    ok: false,
    why: `两端不一致\n        A: ${norm(a)}\n        B: ${norm(b)}`,
  }
}

/**
 * 底线五：客户端显示的和服务端存的要对得上。
 *
 * 客户端本地缓存看着没问题、服务端其实没存下，是最难发现的一类丢失——
 * 换台设备登录才发现东西没了。
 */
export function matchesServer(local, server) {
  const norm = (list) => list.map((n) => n.text.trim()).sort().join(' | ')
  if (norm(local) === norm(server)) return { ok: true }
  return {
    ok: false,
    why: `本地缓存和服务端不一致\n        本地  : ${norm(local)}\n        服务端: ${norm(server)}`,
  }
}
