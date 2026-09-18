import { useMemo, useState } from 'react'
import { useStore, buildTree, type TreeNode } from '@/lib/store'
import * as sync from '@/lib/sync'
import type { Note } from '@/lib/types'
import { useContextMenu } from '../ContextMenu'
import { SearchResults } from '../SearchResults'
import { TagList } from '../TagList'
import { Trash } from '../Trash'
import { SyncChip } from '../SyncChip'
import { FolderSheet } from './FolderSheet'
import { openNotePage } from './MobileShell'
import { IconBack, IconClose, IconFolder, IconFolderOpen, IconPlus, IconSearch, IconSettings, IconTrash } from '../Icons'

/** 卡片上的日期：今年只给月日，往年带年份 */
export function cardDate(ts: number): string {
  const d = new Date(ts)
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`
}

/** 目录连同它所有子目录的 id，筛卡片用 */
function descendants(tree: TreeNode[], rootId: string): Set<string> {
  const out = new Set<string>()
  const walk = (nodes: TreeNode[], inside: boolean) => {
    for (const n of nodes) {
      const hit = inside || n.folder.id === rootId
      if (hit) out.add(n.folder.id)
      walk(n.children, hit)
    }
  }
  walk(tree, false)
  return out
}

/**
 * 手机首页：大标题 + 两列卡片 + 右下角新建。
 * 作用域复用侧栏那套 store 字段（sidebarView / tagFilter / search），
 * 目录过滤是首页自己的事，放本地 state。
 */
interface Props {
  folderId: string | null
  setFolderId: (id: string | null) => void
  onOpenSettings: () => void
}

export function MobileHome({ folderId, setFolderId, onOpenSettings }: Props) {
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const sidebarView = useStore((s) => s.sidebarView)
  const setSidebarView = useStore((s) => s.setSidebarView)
  const tagFilter = useStore((s) => s.tagFilter)
  const setTagFilter = useStore((s) => s.setTagFilter)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const setActive = useStore((s) => s.setActive)

  const [sheet, setSheet] = useState(false)
  const menu = useContextMenu()

  const tree = useMemo(() => buildTree(folders, notes).tree, [folders, notes])
  const folder = folderId ? folders[folderId] : undefined
  // 目录被别的设备删了：退回全部笔记
  const scopedFolder = folder && !folder.deleted ? folder : undefined

  const cards = useMemo(() => {
    let list = Object.values(notes).filter((n) => !n.deleted)
    if (sidebarView === 'tags') {
      list = tagFilter ? list.filter((n) => n.tags?.includes(tagFilter)) : []
    } else if (scopedFolder) {
      const ids = descendants(tree, scopedFolder.id)
      list = list.filter((n) => n.folderId && ids.has(n.folderId))
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [notes, sidebarView, tagFilter, scopedFolder, tree])

  const title =
    sidebarView === 'trash' ? '回收站'
    : sidebarView === 'tags' ? (tagFilter ? `#${tagFilter}` : '标签')
    : scopedFolder ? scopedFolder.name
    : '所有笔记'

  /** 标签筛选 / 回收站 / 目录内：左上角给一个返回上一级 */
  const back =
    sidebarView === 'tags' && tagFilter ? () => setTagFilter(null)
    : sidebarView !== 'tree' ? () => setSidebarView('tree')
    : scopedFolder ? () => setFolderId(null)
    : null

  const open = (note: Note) => {
    setActive(note.id)
    openNotePage()
  }

  const create = async () => {
    // 在目录里就建在目录里；标签 / 回收站视图下建到根
    await sync.createNote(sidebarView === 'tree' ? scopedFolder?.id ?? null : null)
    openNotePage()
  }

  const cardActions = (note: Note) => [
    { label: '移出目录', disabled: !note.folderId, onSelect: () => void sync.moveNote(note.id, null) },
    { label: '删除笔记', danger: true, onSelect: () => void sync.deleteNote(note.id) },
  ]

  let body: React.ReactNode
  if (search.trim()) {
    body = <div className="m-list"><SearchResults query={search.trim()} /></div>
  } else if (sidebarView === 'trash') {
    body = <div className="m-list"><Trash /></div>
  } else if (sidebarView === 'tags' && !tagFilter) {
    body = <div className="m-list"><TagList /></div>
  } else if (!cards.length) {
    body = (
      <div className="m-empty">
        {sidebarView === 'tags' ? '这个标签下还没有笔记' : '还没有笔记，点右下角写一篇'}
      </div>
    )
  } else {
    body = (
      <div className="m-grid">
        {cards.map((n) => (
          <button
            key={n.id}
            className="m-card"
            onClick={() => open(n)}
            onContextMenu={(e) => menu.open(e, cardActions(n))}
          >
            <span className={'m-card-title' + (n.title?.trim() ? '' : ' is-untitled')}>
              {n.title?.trim() || '无标题'}
            </span>
            {n.excerpt && <span className="m-card-excerpt">{n.excerpt}</span>}
            <span className="m-card-date">{cardDate(n.updatedAt)}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="m-home">
      <header className="m-top">
        {back && (
          <button className="m-icon" onClick={back} aria-label="返回">
            <IconBack size={24} />
          </button>
        )}
        <SyncChip />
        <span className="m-top-gap" />
        <button className="m-icon" onClick={() => setSheet(true)} aria-label="目录">
          {scopedFolder ? <IconFolderOpen size={24} /> : <IconFolder size={24} />}
        </button>
        <button className="m-icon" onClick={onOpenSettings} aria-label="设置">
          <IconSettings size={24} />
        </button>
      </header>

      <div className="m-scroll">
        <h1 className="m-title">
          {sidebarView === 'trash' && <IconTrash size={26} className="m-title-icon" />}
          {title}
        </h1>

        {sidebarView !== 'trash' && (
          <label className="m-search">
            <IconSearch size={17} />
            <input
              value={search}
              placeholder="搜索笔记"
              onChange={(e) => setSearch(e.target.value)}
              aria-label="搜索笔记"
            />
            {search && (
              <button className="m-search-clear" onClick={() => setSearch('')} aria-label="清除">
                <IconClose size={14} />
              </button>
            )}
          </label>
        )}

        {body}
      </div>

      {sidebarView !== 'trash' && (
        <button className="m-fab" onClick={() => void create()} aria-label="新建笔记">
          <IconPlus size={30} />
        </button>
      )}

      {sheet && (
        <FolderSheet
          mode="browse"
          current={sidebarView === 'tree' ? (scopedFolder?.id ?? null) : undefined}
          onPick={(id) => {
            setSidebarView('tree')
            setFolderId(id)
            setSheet(false)
          }}
          onView={(view) => {
            setSidebarView(view)
            setSheet(false)
          }}
          onClose={() => setSheet(false)}
        />
      )}
      {menu.node}
    </div>
  )
}
