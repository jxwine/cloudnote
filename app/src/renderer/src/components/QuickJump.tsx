import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/lib/store'
import { folderPath } from '@/lib/search'
import { IconChevron, IconFolder, IconNote, IconSearch } from './Icons'

/** 子序列匹配：输入的字符按顺序出现即可，不必连续。「同纪」能命中「同步方案评审纪要」 */
function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 1
  // 连续子串优先，分数给高一些
  const direct = t.indexOf(q)
  if (direct !== -1) return 1000 - direct

  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at === -1) return 0
    streak = at === ti ? streak + 1 : 0
    score += 10 + streak * 5 - Math.min(at - ti, 20)
    ti = at + 1
  }
  return Math.max(1, score)
}

/** Ctrl+P 快速跳转：输入标题片段，回车打开 */
export function QuickJump({ onClose }: { onClose: () => void }) {
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const setActive = useStore((s) => s.setActive)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const hits = useMemo(() => {
    const live = Object.values(notes).filter((n) => !n.deleted)
    const q = query.trim()
    return live
      .map((note) => ({ note, score: fuzzyScore(note.title || '无标题', q) }))
      .filter((x) => x.score > 0)
      // 没输入时按最近修改排，输入了按匹配度排
      .sort((a, b) => (q ? b.score - a.score : b.note.updatedAt - a.note.updatedAt))
      .slice(0, 30)
  }, [notes, query])

  useEffect(() => setCursor(0), [query])
  useEffect(() => inputRef.current?.focus(), [])

  /* 让选中项始终留在可视区里 */
  useEffect(() => {
    listRef.current?.querySelector('.jump-item.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const open = (id: string) => {
    setActive(id)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (hits.length ? (c + 1) % hits.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (hits.length ? (c - 1 + hits.length) % hits.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[cursor]
      if (hit) open(hit.note.id)
    }
  }

  return (
    <div className="overlay overlay-top" onMouseDown={onClose}>
      <div className="jump" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="jump-search">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="跳到笔记…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="jump-list" ref={listRef}>
          {hits.length ? (
            hits.map(({ note }, i) => {
              const path = folderPath(note.folderId, folders)
              return (
                <button
                  key={note.id}
                  className={'jump-item' + (i === cursor ? ' is-active' : '')}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => open(note.id)}
                >
                  <IconNote size={15} className="jump-icon" />
                  <span className="jump-title">{note.title?.trim() || '无标题'}</span>
                  {path.length > 0 && (
                    <span className="jump-path">
                      <IconFolder size={12} />
                      {path.map((name) => (
                        <span key={name} className="jump-path-part">
                          <IconChevron size={10} />
                          {name}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              )
            })
          ) : (
            <div className="tree-empty">没有匹配的笔记</div>
          )}
        </div>
      </div>
    </div>
  )
}
