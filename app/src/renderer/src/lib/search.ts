import type { Folder, Note } from './types'

export interface SearchHit {
  note: Note
  /** 命中处的上下文，切成三段方便把关键词单独高亮出来 */
  snippet: { before: string; match: string; after: string } | null
  /** 从根到所在目录的名字，根层级为空数组 */
  path: string[]
  /** 全文里命中了多少次，用来排序：命中多的更可能是想找的 */
  count: number
}

const CONTEXT_BEFORE = 18
const CONTEXT_AFTER = 46

/**
 * 正文剥标签的结果按「笔记 id + 修改时间」缓存起来。
 * 搜索框每敲一个字都要把所有笔记过一遍正则，几百篇就能卡出手感来。
 */
const textCache = new Map<string, { stamp: number; text: string }>()
const TEXT_CACHE_MAX = 2000

function cachedPlainText(id: string, html: string, stamp: number): string {
  const hit = textCache.get(id)
  if (hit && hit.stamp === stamp) return hit.text
  const text = plainText(html)
  // 简单地整体丢弃：缓存只是加速，重建代价可控
  if (textCache.size >= TEXT_CACHE_MAX) textCache.clear()
  textCache.set(id, { stamp, text })
  return text
}

/** 去掉标签、把实体和空白规整掉，得到可供检索和展示的纯文本 */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取关键词第一次出现处的上下文；命中在标题里而正文没有时返回 null */
export function makeSnippet(text: string, query: string): SearchHit['snippet'] {
  const at = text.toLowerCase().indexOf(query)
  if (at === -1) return null
  const start = Math.max(0, at - CONTEXT_BEFORE)
  const end = Math.min(text.length, at + query.length + CONTEXT_AFTER)
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + query.length),
    after: text.slice(at + query.length, end) + (end < text.length ? '…' : ''),
  }
}

const countOccurrences = (haystack: string, needle: string) => {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

/** 从笔记所在目录一路往上，拼出面包屑 */
export function folderPath(folderId: string | null, folders: Record<string, Folder>): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let cursor = folderId
  while (cursor && folders[cursor] && !seen.has(cursor)) {
    seen.add(cursor)
    path.unshift(folders[cursor].name)
    cursor = folders[cursor].parentId
  }
  return path
}

/**
 * 全文检索。标题命中权重更高，其次看正文命中次数，最后按修改时间。
 */
export function searchNotes(
  query: string,
  notes: Record<string, Note>,
  folders: Record<string, Folder>,
  limit = 200
): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const hits: (SearchHit & { titleHit: boolean })[] = []
  for (const note of Object.values(notes)) {
    if (note.deleted) continue
    const title = (note.title || '').toLowerCase()
    const body = cachedPlainText(note.id, note.content || '', note.updatedAt)
    const bodyLower = body.toLowerCase()

    const titleHit = title.includes(q)
    const count = countOccurrences(bodyLower, q)
    if (!titleHit && count === 0) continue

    hits.push({
      note,
      snippet: makeSnippet(body, q),
      path: folderPath(note.folderId, folders),
      count,
      titleHit,
    })
  }

  hits.sort((a, b) => {
    if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1
    if (a.count !== b.count) return b.count - a.count
    return b.note.updatedAt - a.note.updatedAt
  })

  return hits.slice(0, limit).map(({ titleHit: _titleHit, ...hit }) => hit)
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
}
