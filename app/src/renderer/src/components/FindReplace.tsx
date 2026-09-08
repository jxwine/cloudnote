import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  applySearchTerm, getHighlightState, replaceAll, replaceCurrent, stepMatch,
} from '@/lib/searchHighlight'
import { useStore } from '@/lib/store'
import { IconChevron, IconClose } from './Icons'

interface Props {
  editor: Editor | null
  scrollRef: React.RefObject<HTMLDivElement>
  /** 打开时若有选中文字，用它作查找词 */
  initialTerm: string
  onClose: () => void
}

/** 编辑器内的查找替换条。Ctrl+F 打开，Esc 关闭。 */
export function FindReplace({ editor, scrollRef, initialTerm, onClose }: Props) {
  const [term, setTerm] = useState(initialTerm)
  const [replacement, setReplacement] = useState('')
  const findRef = useRef<HTMLInputElement>(null)
  const showToast = useStore((s) => s.showToast)
  const [, tick] = useState(0)

  // 命中数和当前序号都存在编辑器的插件状态里，React 不会自己知道它变了，
  // 订阅事务来触发重渲染，否则计数会停在旧值上
  useEffect(() => {
    if (!editor) return
    const bump = () => tick((n) => n + 1)
    editor.on('transaction', bump)
    return () => {
      editor.off('transaction', bump)
    }
  }, [editor])

  const { current, matches } = getHighlightState(editor)
  const total = matches.length

  useEffect(() => {
    findRef.current?.focus()
    findRef.current?.select()
  }, [])

  /* 查找词变了就重新标记，并回到第一处 */
  useEffect(() => {
    applySearchTerm(editor, term.trim())
  }, [editor, term])

  /* 当前命中变了就滚过去 */
  useEffect(() => {
    const hit = scrollRef.current?.querySelector('.search-hit.is-current')
    hit?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [current, term, scrollRef])

  /* 关掉时清除高亮，别把标记留在正文上 */
  useEffect(() => () => applySearchTerm(editor, ''), [editor])

  const go = (delta: number) => {
    stepMatch(editor, delta)
    findRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    }
  }

  return (
    <div className="findbar" onKeyDown={onKeyDown}>
      <div className="findbar-row">
        <input
          ref={findRef}
          className="findbar-input"
          value={term}
          placeholder="查找"
          spellCheck={false}
          onChange={(e) => setTerm(e.target.value)}
        />

        <span className={'findbar-count' + (term.trim() && !total ? ' is-empty' : '')}>
          {term.trim() ? (total ? `${current + 1}/${total}` : '无结果') : ''}
        </span>

        <button className="icon-btn" title="上一处 (Shift+Enter)" disabled={!total} onClick={() => go(-1)}>
          <IconChevron size={14} className="rot-up" />
        </button>
        <button className="icon-btn" title="下一处 (Enter)" disabled={!total} onClick={() => go(1)}>
          <IconChevron size={14} className="rot-down" />
        </button>
        <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
          <IconClose size={13} />
        </button>
      </div>

      <div className="findbar-row">
        <input
          className="findbar-input"
          value={replacement}
          placeholder="替换为"
          spellCheck={false}
          onChange={(e) => setReplacement(e.target.value)}
        />
        <button
          className="btn-ghost findbar-action"
          disabled={!total}
          onClick={() => {
            replaceCurrent(editor, replacement)
            findRef.current?.focus()
          }}
        >
          替换
        </button>
        <button
          className="btn-ghost findbar-action"
          disabled={!total}
          onClick={() => {
            const n = replaceAll(editor, replacement)
            if (n) showToast({ message: `已替换 ${n} 处` })
            findRef.current?.focus()
          }}
        >
          全部替换
        </button>
      </div>
    </div>
  )
}
