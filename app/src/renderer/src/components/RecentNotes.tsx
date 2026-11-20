import { useMemo, useState } from 'react'
import { blockedLock, canReadNote, readingTitle } from '@/lib/readingLock'
import { formatDate } from '@/lib/search'
import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'
import { IconBack, IconChevronDown, IconFolder, IconList, IconLock, IconNote, IconPlus, IconSearch } from './Icons'

const VIEW_KEY = 'cloudnote.recentView'
const SCOPES = [{ id: 'all', label: '全部笔记' }, { id: 'folders', label: '目录层级' }] as const
const LAYOUTS = [{ id: 'cards', label: '摘要卡片' }, { id: 'details', label: '详细列表' }, { id: 'titles', label: '标题列表' }] as const
type View = `${typeof SCOPES[number]['id']}-${typeof LAYOUTS[number]['id']}`

function readView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    for (const scope of SCOPES) {
      for (const layout of LAYOUTS) {
        const value: View = `${scope.id}-${layout.id}`
        if (value === saved) return value
      }
    }
  } catch { /* 存储不可用时仍可浏览和切换视图。 */ }
  return 'all-cards'
}

interface Props {
  folderId: string | null
  onFolderChange: (id: string | null) => void
  onSearch: () => void
}

export function RecentNotes({ folderId, onFolderChange, onSearch }: Props) {
  const notes = useStore((state) => state.notes)
  const folders = useStore((state) => state.folders)
  const lockGrants = useStore((state) => state.lockGrants)
  const setActive = useStore((state) => state.setActive)
  const openFolder = useStore((state) => state.openFolder)
  const [view, setView] = useState(readView)
  const [scope, layout] = view.split('-')
  const byFolder = scope === 'folders'

  const { currentFolder, childFolders, recent } = useMemo(() => {
    const state = { notes, folders, lockGrants }
    const folder = byFolder && folderId ? folders[folderId] : undefined
    const currentFolder = folder && !folder.deleted && !blockedLock(state, { kind: 'folder', id: folder.id }) ? folder : undefined
    const isHere = (parentId: string | null) => currentFolder
      ? parentId === currentFolder.id
      : !parentId || !folders[parentId] || folders[parentId].deleted

    const childFolders = byFolder ? Object.values(folders)
      .filter((item) => !item.deleted && isHere(item.parentId))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((item) => {
        const target = { kind: 'folder' as const, id: item.id }
        return { id: item.id, title: readingTitle(state, target), locked: !!blockedLock(state, target) }
      }) : []
    const recent = Object.values(notes)
      .filter((note) => !note.deleted && (!byFolder || isHere(note.folderId)) && canReadNote(state, note))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    return { currentFolder, childFolders, recent }
  }, [notes, folders, lockGrants, byFolder, folderId])

  const title = currentFolder?.name || (byFolder ? '目录' : '最近笔记')
  const hasItems = recent.length > 0 || childFolders.length > 0

  return (
    <main className="editor-pane recent-pane" aria-labelledby="recent-title">
      <div className="recent-content">
        <header className="recent-header">
          <div className="recent-heading">
            {currentFolder && (
              <button type="button" className="recent-back icon-btn" title="返回上级目录" aria-label="返回上级目录"
                onClick={() => onFolderChange(currentFolder.parentId)}>
                <IconBack size={17} />
              </button>
            )}
            <div className="recent-title-group">
              <h1 id="recent-title" title={currentFolder?.name}>{title}</h1>
              <p>{childFolders.length > 0 && `${childFolders.length} 个目录 · `}{recent.length} 篇笔记</p>
            </div>
          </div>
          <div className="recent-actions">
            <button type="button" className="btn-primary recent-create" onClick={() => void sync.createNote(currentFolder?.id ?? null)}>
              <IconPlus size={16} />
              新建笔记
            </button>
            <button type="button" className="icon-btn recent-search" aria-label="搜索笔记" title="搜索笔记" onClick={onSearch}>
              <IconSearch size={17} />
            </button>
          </div>
        </header>

        <div className="recent-toolbar">
          <label className="recent-view">
            <IconList size={16} />
            <select aria-label="显示方式" value={view} onChange={(event) => {
              const next = event.target.value as View
              setView(next)
              try { localStorage.setItem(VIEW_KEY, next) } catch { /* 当前窗口继续使用新视图。 */ }
            }}>
              {SCOPES.map(({ id, label }) => (
                <optgroup key={id} label={label}>
                  {LAYOUTS.map((item) => (
                    <option key={item.id} value={`${id}-${item.id}`}>{id === 'folders' ? `目录 + ${item.label}` : item.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <IconChevronDown size={13} />
          </label>
        </div>

        {hasItems ? (
          <div className={`recent-items recent-items--${layout}`}>
            {childFolders.map((folder) => (
              <button key={`folder-${folder.id}`} type="button" className="recent-item recent-folder" onClick={() => {
                onFolderChange(folder.id)
                if (folder.locked) openFolder(folder.id)
              }}>
                <span className="recent-item-title">
                  {folder.locked ? <IconLock size={16} /> : <IconFolder size={17} />}
                  <span>{folder.title}</span>
                </span>
                {layout !== 'titles' && <span className="recent-item-meta">{folder.locked ? '需阅读密码' : '目录'}</span>}
              </button>
            ))}
            {recent.map((note) => (
              <button key={note.id} type="button" className="recent-item recent-note" onClick={() => setActive(note.id)}>
                <span className="recent-item-title">
                  {layout !== 'cards' && <IconNote size={16} />}
                  <span>{note.title?.trim() || '无标题'}</span>
                </span>
                {layout !== 'titles' && (
                  <>
                    {note.excerpt && <span className="recent-item-excerpt">{note.excerpt}</span>}
                    <span className="recent-item-meta">{formatDate(note.updatedAt)}</span>
                  </>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="recent-empty">
            <IconNote size={26} />
            <p>{currentFolder ? '这个目录还没有可显示的笔记' : '还没有可显示的笔记'}</p>
          </div>
        )}
      </div>
    </main>
  )
}
