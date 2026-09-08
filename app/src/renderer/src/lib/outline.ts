import type { Editor } from '@tiptap/react'
import type { OutlineItem } from './types'

/** 遍历文档里的 heading 节点，生成右侧大纲用的扁平列表 */
export function extractOutline(editor: Editor | null): OutlineItem[] {
  if (!editor) return []
  const items: OutlineItem[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return
    const text = node.textContent.trim()
    items.push({
      id: `h-${pos}`,
      level: node.attrs.level as number,
      text: text || '无标题小节',
      pos,
    })
  })
  return items
}

/** 从正文提取笔记标题：优先第一个标题，其次第一段有字的内容 */
export function deriveTitle(editor: Editor | null): string {
  if (!editor) return ''
  let title = ''
  editor.state.doc.descendants((node) => {
    if (title) return false
    if (node.type.name === 'heading' || node.type.name === 'paragraph') {
      const text = node.textContent.trim()
      if (text) title = text
    }
    return !title
  })
  return title.slice(0, 120)
}

/** 列表页显示的摘要：跳过标题行，取正文前若干字 */
export function deriveExcerpt(editor: Editor | null, title: string): string {
  if (!editor) return ''
  const full = editor.state.doc.textBetween(0, editor.state.doc.content.size, ' ', ' ').trim()
  const body = full.startsWith(title) ? full.slice(title.length).trim() : full
  return body.replace(/\s+/g, ' ').slice(0, 160)
}

/**
 * 滚动到文档里的某个位置，让它停在编辑区偏上处而不是贴着顶边。
 * 用 coordsAtPos 而不是 nodeDOM：后者对文本位置返回的是文本节点，量不到坐标，
 * 搜索命中的跳转就会失效。
 */
export function scrollToPos(editor: Editor | null, pos: number, container: HTMLElement | null) {
  if (!editor || !container) return
  let top: number
  try {
    top = editor.view.coordsAtPos(pos).top
  } catch {
    return // 位置已经不在文档里了（内容刚变过）
  }
  const offset = top - container.getBoundingClientRect().top + container.scrollTop
  container.scrollTo({ top: Math.max(0, offset - 96), behavior: 'smooth' })
}

/** 找出当前视口里「正在读」的那个标题，用于大纲高亮 */
export function activeHeading(
  editor: Editor | null,
  items: OutlineItem[],
  container: HTMLElement | null
): string | null {
  if (!editor || !container || !items.length) return null
  const anchor = container.getBoundingClientRect().top + 100
  let current = items[0].id
  for (const item of items) {
    const dom = editor.view.nodeDOM(item.pos) as HTMLElement | null
    if (!dom || !dom.getBoundingClientRect) continue
    if (dom.getBoundingClientRect().top <= anchor) current = item.id
    else break
  }
  return current
}
