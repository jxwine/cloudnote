import { useMemo, useState } from 'react'
import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'
import { folderPath, formatDate } from '@/lib/search'
import { IconChevron, IconFolder, IconNote, IconRestore, IconTrash } from './Icons'

/** 回收站：删掉的笔记在这里等着，可以放回去，也可以彻底清掉 */
export function Trash() {
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const [purging, setPurging] = useState<string | null>(null)

  const items = useMemo(
    () =>
      Object.values(notes)
        .filter((n) => n.deleted)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [notes]
  )

  if (!items.length) {
    return (
      <div className="tree-empty">
        回收站是空的。
        <br />
        删掉的笔记会先放到这里。
      </div>
    )
  }

  return (
    <>
      <div className="search-count">
        {items.length} 篇已删除
        <button
          className="trash-purge-all"
          onClick={() => {
            if (purging === '__all__') {
              items.forEach((n) => void sync.purgeNote(n.id))
              setPurging(null)
            } else {
              setPurging('__all__')
            }
          }}
        >
          {purging === '__all__' ? '确认清空？' : '清空'}
        </button>
      </div>

      <div className="hit-list">
        {items.map((note) => {
          const path = folderPath(note.folderId, folders)
          return (
            <div key={note.id} className="hit is-trash">
              <span className="hit-title">
                <IconNote size={15} className="hit-title-icon" />
                <span className="hit-title-text">{note.title?.trim() || '无标题'}</span>
              </span>

              {note.excerpt && <span className="hit-snippet">{note.excerpt}</span>}

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

              <span className="trash-actions">
                <button className="btn-ghost" onClick={() => void sync.restoreNote(note.id)}>
                  <IconRestore size={14} />
                  放回去
                </button>
                <button
                  className={'btn-ghost is-danger' + (purging === note.id ? ' is-armed' : '')}
                  onClick={() => {
                    if (purging === note.id) {
                      void sync.purgeNote(note.id)
                      setPurging(null)
                    } else {
                      setPurging(note.id)
                    }
                  }}
                  onBlur={() => setPurging((p) => (p === note.id ? null : p))}
                >
                  <IconTrash size={14} />
                  {purging === note.id ? '确认删除？' : '彻底删除'}
                </button>
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
