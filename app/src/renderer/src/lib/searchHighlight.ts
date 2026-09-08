import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'

export interface Match {
  from: number
  to: number
}

export interface HighlightState {
  term: string
  /** 当前命中的序号，导航和替换都作用在它上面 */
  current: number
  matches: Match[]
  decorations: DecorationSet
}

export const searchHighlightKey = new PluginKey<HighlightState>('searchHighlight')

const EMPTY: HighlightState = { term: '', current: 0, matches: [], decorations: DecorationSet.empty }

function build(doc: PMNode, term: string, current: number): HighlightState {
  if (!term) return EMPTY

  const needle = term.toLowerCase()
  const matches: Match[] = []

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const haystack = node.text.toLowerCase()
    let at = haystack.indexOf(needle)
    while (at !== -1) {
      matches.push({ from: pos + at, to: pos + at + needle.length })
      at = haystack.indexOf(needle, at + needle.length)
    }
  })

  const safeCurrent = matches.length ? Math.min(Math.max(current, 0), matches.length - 1) : 0
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) =>
      // 当前那一处单独标记：它是跳转落点，得比其它命中显眼
      Decoration.inline(m.from, m.to, {
        class: i === safeCurrent ? 'search-hit is-current' : 'search-hit',
      })
    )
  )
  return { term, current: safeCurrent, matches, decorations }
}

interface SetMeta {
  term: string
  current?: number
}

/**
 * 把命中处标出来。纯装饰，不进文档内容，
 * 所以不会被保存，也不会算进同步冲突。
 */
export const SearchHighlight = Extension.create({
  name: 'searchHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightState>({
        key: searchHighlightKey,
        state: {
          init: () => EMPTY,
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(searchHighlightKey) as SetMeta | undefined
            if (meta) return build(newState.doc, meta.term, meta.current ?? 0)
            if (!value.term) return value
            // 文档变了要重新找，否则装饰位置会跟内容错开
            return tr.docChanged ? build(newState.doc, value.term, value.current) : value
          },
        },
        props: {
          decorations: (state) => searchHighlightKey.getState(state)?.decorations,
        },
      }),
    ]
  },
})

export const getHighlightState = (editor: Editor | null): HighlightState =>
  (editor && !editor.isDestroyed ? searchHighlightKey.getState(editor.state) : null) ?? EMPTY

/** 设置查找词；传空串即清除高亮 */
export function applySearchTerm(editor: Editor | null, term: string, current = 0): void {
  if (!editor || editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, { term, current }))
}

/** 在命中之间前后移动，到头循环 */
export function stepMatch(editor: Editor | null, delta: number): void {
  if (!editor || editor.isDestroyed) return
  const { term, current, matches } = getHighlightState(editor)
  if (!matches.length) return
  const next = (current + delta + matches.length) % matches.length
  editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, { term, current: next }))
}

/** 替换当前这一处，替换完停在原位（后面的命中会顶上来） */
export function replaceCurrent(editor: Editor | null, replacement: string): boolean {
  if (!editor || editor.isDestroyed) return false
  const { term, current, matches } = getHighlightState(editor)
  const target = matches[current]
  if (!target) return false

  const tr = editor.state.tr.insertText(replacement, target.from, target.to)
  tr.setMeta(searchHighlightKey, { term, current })
  editor.view.dispatch(tr)
  return true
}

/** 全部替换。从后往前改，这样前面命中的位置不会被长度变化推偏 */
export function replaceAll(editor: Editor | null, replacement: string): number {
  if (!editor || editor.isDestroyed) return 0
  const { term, matches } = getHighlightState(editor)
  if (!matches.length) return 0

  const tr = editor.state.tr
  for (let i = matches.length - 1; i >= 0; i--) {
    tr.insertText(replacement, matches[i].from, matches[i].to)
  }
  tr.setMeta(searchHighlightKey, { term, current: 0 })
  editor.view.dispatch(tr)
  return matches.length
}
