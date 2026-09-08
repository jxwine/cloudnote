import { useMemo } from 'react'
import { useStore } from '@/lib/store'
import { IconTag } from './Icons'

/** 标签总览：所有用过的标签和各自的篇数，点一个就筛它 */
export function TagList() {
  const notes = useStore((s) => s.notes)
  const setTagFilter = useStore((s) => s.setTagFilter)

  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const note of Object.values(notes)) {
      if (note.deleted) continue
      for (const tag of note.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    // 用得多的排前面，同频次按名字排，顺序才稳定
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  }, [notes])

  if (!tags.length) {
    return (
      <div className="tree-empty">
        还没有标签。
        <br />
        在笔记标题上方点「＋ 标签」加一个。
      </div>
    )
  }

  return (
    <>
      <div className="search-count">共 {tags.length} 个标签</div>
      <div className="taglist">
        {tags.map(([tag, count]) => (
          <button key={tag} className="taglist-item" onClick={() => setTagFilter(tag)}>
            <IconTag size={14} className="taglist-icon" />
            <span className="taglist-name">{tag}</span>
            <span className="tree-count">{count}</span>
          </button>
        ))}
      </div>
    </>
  )
}
