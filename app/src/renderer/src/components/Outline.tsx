import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { activeHeading, extractOutline, scrollToPos } from '@/lib/outline'
import type { OutlineItem } from '@/lib/types'

interface Props {
  editor: Editor | null
  scrollRef: React.RefObject<HTMLDivElement>
  noteId: string | null
}

export function Outline({ editor, scrollRef, noteId }: Props) {
  const [items, setItems] = useState<OutlineItem[]>([])
  const [active, setActive] = useState<string | null>(null)

  /* 文档结构变化时重算大纲 */
  useEffect(() => {
    if (!editor) {
      setItems([])
      return
    }
    const refresh = () => setItems(extractOutline(editor))
    refresh()

    // 听 transaction 而不是 update：别端推来的改动是用
    // setContent(..., { emitUpdate: false }) 灌进来的，不会发 update
    //（那个标志是为了避免把收到的内容又当成自己的输入存回去），
    // 只听 update 的话，正文更新了大纲却停在旧标题上。
    // transaction 每次光标移动也会来，所以只在文档真的变了时才重算。
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) refresh()
    }
    editor.on('transaction', onTransaction)
    return () => {
      editor.off('transaction', onTransaction)
    }
  }, [editor, noteId])

  /* 跟随滚动高亮当前所在的标题 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !editor || !items.length) {
      setActive(null)
      return
    }
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setActive(activeHeading(editor, items, el)))
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
    }
  }, [editor, items, scrollRef])

  if (!noteId) {
    return <div className="tree-empty">打开一篇笔记后，这里会列出它的标题。</div>
  }

  if (!items.length) {
    return (
      <div className="tree-empty">
        还没有标题。
        <br />
        在正文里用「# 」开头写一行，就会出现在这里。
      </div>
    )
  }

  return (
    <nav className="outline" aria-label="笔记大纲">
      {items.map((item) => (
        <button
          key={item.id}
          className={`outline-item lv-${item.level}` + (active === item.id ? ' is-active' : '')}
          title={item.text}
          onClick={() => {
            scrollToPos(editor, item.pos, scrollRef.current)
            setActive(item.id)
          }}
        >
          <span className="outline-text">{item.text}</span>
        </button>
      ))}
    </nav>
  )
}
