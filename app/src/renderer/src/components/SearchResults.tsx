import { useMemo } from 'react'
import { useStore } from '@/lib/store'
import { formatDate, searchNotes } from '@/lib/search'
import { IconChevron, IconFolder, IconNote } from './Icons'

/** 搜索结果：标题 + 命中上下文 + 所在目录 + 修改日期，点一条就跳到正文里那处 */
export function SearchResults({ query }: { query: string }) {
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const activeNoteId = useStore((s) => s.activeNoteId)
  const jumpToSearchHit = useStore((s) => s.jumpToSearchHit)

  const hits = useMemo(() => searchNotes(query, notes, folders), [query, notes, folders])

  if (!hits.length) {
    return <div className="tree-empty">没有匹配「{query}」的笔记</div>
  }

  return (
    <>
      <div className="search-count">共 {hits.length} 项</div>
      <div className="hit-list">
        {hits.map(({ note, snippet, path, count }) => (
          <button
            key={note.id}
            className={'hit' + (note.id === activeNoteId ? ' is-active' : '')}
            onClick={() => jumpToSearchHit(note.id)}
          >
            <span className="hit-title">
              <IconNote size={15} className="hit-title-icon" />
              <span className="hit-title-text">{note.title?.trim() || '无标题'}</span>
              {count > 1 && <span className="hit-count">{count}</span>}
            </span>

            {snippet && (
              <span className="hit-snippet">
                {snippet.before}
                <mark>{snippet.match}</mark>
                {snippet.after}
              </span>
            )}

            <span className="hit-meta">
              <span className="hit-path">
                <IconFolder size={13} />
                <span>全部笔记</span>
                {path.map((name) => (
                  <span key={name} className="hit-path-part">
                    <IconChevron size={11} />
                    <span>{name}</span>
                  </span>
                ))}
              </span>
              <span className="hit-date">{formatDate(note.updatedAt)}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  )
}
