import { useMemo, useState, type ReactNode } from 'react'
import { blockedLock, readingTitle } from '@/lib/readingLock'
import { formatDate } from '@/lib/search'
import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'
import type { LockTarget } from '@/lib/types'
import { formatBytes } from '@/lib/update'
import { useContextMenu } from './ContextMenu'
import { desktopItemActions } from './desktopItemActions'
import { IconBack, IconChevronDown, IconFolder, IconList, IconLock, IconNote, IconPlus, IconSearch } from './Icons'
import { RenameInput } from './RenameInput'

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
  const [renameTarget, setRenameTarget] = useState<LockTarget | null>(null)
  const menu = useContextMenu()
  const [scope, layout] = view.split('-')
  const byFolder = scope === 'folders'
  const showSizes = layout !== 'cards'

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
      .filter((note) => !note.deleted && (!byFolder || isHere(note.folderId)))
      .flatMap((note) => {
        const target = { kind: 'note' as const, id: note.id }
        const blocking = blockedLock(state, target)
        if (blocking?.kind === 'folder') return []
        return [{ note, locked: !!blocking, title: blocking ? readingTitle(state, target) : note.title?.trim() || '' }]
      })
      .sort((a, b) => b.note.updatedAt - a.note.updatedAt || a.note.id.localeCompare(b.note.id))
    return { currentFolder, childFolders, recent }
  }, [notes, folders, lockGrants, byFolder, folderId])

  const sizes = useMemo(() => showSizes
    ? new Map(recent.map(({ note }) => [note.id, formatBytes(new Blob([note.content ?? '']).size, 1)]))
    : null, [recent, showSizes])

  const title = currentFolder?.name || (byFolder ? '目录' : '最近笔记')
  const hasItems = recent.length > 0 || childFolders.length > 0

  const renderItem = (target: LockTarget, initial: string, icon: ReactNode, details: ReactNode, onOpen: () => void, locked = false) => {
    const renaming = !locked && renameTarget?.kind === target.kind && renameTarget.id === target.id
    const Item = renaming ? 'div' : 'button'
    const commitRename = (name: string) => {
      setRenameTarget(null)
      if (!name || name === initial) return
      const current = useStore.getState()
      const item = target.kind === 'folder' ? current.folders[target.id] : current.notes[target.id]
      if (!item || item.deleted || blockedLock(current, target)) return
      if (target.kind === 'folder') void sync.renameFolder(target.id, name)
      else void sync.renameNote(target.id, name)
    }
    return (
      <Item key={`${target.kind}-${target.id}`} className={`recent-item recent-${target.kind}`}
        type={renaming ? undefined : 'button'} onClick={renaming ? undefined : onOpen}
        onContextMenu={renaming ? undefined : (event) => menu.open(event, desktopItemActions(target, () => setRenameTarget(target)))}>
        <span className="recent-item-title">
          {icon}
          {renaming ? <RenameInput initial={initial} onCommit={commitRename} /> : <span>{initial || '无标题'}</span>}
        </span>
        {details}
      </Item>
    )
  }

  return (
    <main className="editor-pane recent-pane" aria-labelledby="recent-title" onScroll={menu.close}>
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
              setRenameTarget(null)
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
            {childFolders.map((folder) => renderItem(
              { kind: 'folder', id: folder.id }, folder.title,
              folder.locked ? <IconLock size={16} /> : <IconFolder size={17} />,
              layout !== 'titles' && <span className="recent-item-meta">{folder.locked ? '需阅读密码' : '目录'}</span>,
              () => {
                onFolderChange(folder.id)
                if (folder.locked) openFolder(folder.id)
              },
              folder.locked,
            ))}
            {recent.map(({ note, locked, title }) => {
              const lockedCard = locked && layout === 'cards'
              const excerpt = locked ? '内容已锁定' : note.excerpt
              return renderItem(
                { kind: 'note', id: note.id }, title, layout !== 'cards' && <IconNote size={16} />,
                lockedCard ? (
                  <span className="recent-item-lock-preview" role="img" aria-label="内容已锁定">
                    <IconLock size={48} />
                  </span>
                ) : (
                  <>
                    {layout !== 'titles' && excerpt && <span className="recent-item-excerpt">{excerpt}</span>}
                    <span className="recent-item-meta">
                      {locked && (
                        <span className="recent-item-lock" role="img" aria-label="已锁定" title="已锁定">
                          <IconLock size={14} />
                        </span>
                      )}
                      <span>{formatDate(note.updatedAt)}</span>
                      {sizes && <span className="recent-item-size" title="笔记大小">{sizes.get(note.id)}</span>}
                    </span>
                  </>
                ),
                () => setActive(note.id),
                locked,
              )
            })}
          </div>
        ) : (
          <div className="recent-empty">
            <IconNote size={26} />
            <p>{currentFolder ? '这个目录还没有可显示的笔记' : '还没有可显示的笔记'}</p>
          </div>
        )}
      </div>
      {menu.node}
    </main>
  )
}
