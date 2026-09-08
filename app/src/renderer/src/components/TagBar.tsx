import { useMemo, useRef, useState } from 'react'
import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'
import type { Note } from '@/lib/types'
import { IconClose, IconPlus, IconTag } from './Icons'

/** 笔记标题下的标签条：加标签、删标签，点一下按该标签筛选 */
export function TagBar({ note }: { note: Note }) {
  const notes = useStore((s) => s.notes)
  const setTagFilter = useStore((s) => s.setTagFilter)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  /** 已用过的标签拿来做补全，避免同一个概念写出好几种写法 */
  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase()
    const counts = new Map<string, number>()
    for (const n of Object.values(notes)) {
      if (n.deleted) continue
      for (const t of n.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()]
      .filter(([t]) => !note.tags?.includes(t) && (!q || t.toLowerCase().includes(q)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t]) => t)
  }, [notes, draft, note.tags])

  const commit = (value: string) => {
    const tag = value.trim().slice(0, 24)
    if (tag && !note.tags?.includes(tag)) {
      void sync.setTags(note.id, [...(note.tags ?? []), tag])
    }
    setDraft('')
    setAdding(false)
  }

  const remove = (tag: string) => {
    void sync.setTags(
      note.id,
      (note.tags ?? []).filter((t) => t !== tag)
    )
  }

  return (
    <div className="tagbar">
      {(note.tags ?? []).map((tag) => (
        <span key={tag} className="tag">
          <button className="tag-name" title={`只看「${tag}」`} onClick={() => setTagFilter(tag)}>
            <IconTag size={11} />
            {tag}
          </button>
          <button className="tag-remove" title="移除标签" onClick={() => remove(tag)}>
            <IconClose size={10} />
          </button>
        </span>
      ))}

      {adding ? (
        <span className="tag-input-wrap">
          <input
            ref={inputRef}
            className="tag-input"
            value={draft}
            placeholder="标签名"
            autoFocus
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              // 留点时间给候选项的点击
              setTimeout(() => {
                setAdding(false)
                setDraft('')
              }, 150)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(draft)
              if (e.key === 'Escape') {
                setDraft('')
                setAdding(false)
              }
            }}
          />
          {suggestions.length > 0 && (
            <span className="tag-suggest">
              {suggestions.map((t) => (
                <button key={t} className="tag-suggest-item" onMouseDown={() => commit(t)}>
                  {t}
                </button>
              ))}
            </span>
          )}
        </span>
      ) : (
        <button className="tag-add" title="添加标签" onClick={() => setAdding(true)}>
          <IconPlus size={12} />
          标签
        </button>
      )}
    </div>
  )
}
