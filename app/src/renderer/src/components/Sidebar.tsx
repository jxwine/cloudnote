import { useCallback, useMemo, useRef, useState } from 'react'
import { useStore, useBindings, buildTree, type TreeNode } from '@/lib/store'
import { formatCombo } from '@/lib/shortcuts'
import * as sync from '@/lib/sync'
import { exportAll, exportNote } from '@/lib/export'
import type { Note } from '@/lib/types'
import {
  canDrop, orderBetween, parentOf, positionInRow, siblingsOf,
  type DragPayload, type DropPosition, type DropTarget,
} from '@/lib/dnd'
import { useContextMenu, type MenuAction } from './ContextMenu'
import { SearchResults } from './SearchResults'
import { Trash } from './Trash'
import { TagList } from './TagList'
import {
  IconChevron, IconFolder, IconFolderOpen, IconNote, IconPlus, IconFolderPlus,
  IconSearch, IconTrash, IconPencil, IconClose, IconMore, IconTag, IconExport, IconChevron as IconBack,
} from './Icons'

const DND_MIME = 'application/x-cloudnote'
/** 拖着悬停在折叠的目录上多久自动展开 */
const HOVER_EXPAND_MS = 700

export function Sidebar() {
  const bindings = useBindings()
  const folders = useStore((s) => s.folders)
  const notes = useStore((s) => s.notes)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const activeNoteId = useStore((s) => s.activeNoteId)
  const toggleExpand = useStore((s) => s.toggleExpand)
  const sidebarView = useStore((s) => s.sidebarView)
  const setSidebarView = useStore((s) => s.setSidebarView)
  const tagFilter = useStore((s) => s.tagFilter)
  const setTagFilter = useStore((s) => s.setTagFilter)
  const tagCount = useStore((s) => {
    const seen = new Set<string>()
    for (const n of Object.values(s.notes)) if (!n.deleted) for (const t of n.tags ?? []) seen.add(t)
    return seen.size
  })

  // 拖拽负载同时存 ref 和 state：ref 供事件回调即时读取（dragstart 与 dragover
  // 之间 React 可能还没提交状态），state 只用来驱动高亮
  const draggingRef = useRef<DragPayload | null>(null)
  const [dragging, setDragging] = useState<DragPayload | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menu = useContextMenu()

  const { tree, rootNotes } = useMemo(() => buildTree(folders, notes), [folders, notes])

  const tagged = useMemo(
    () =>
      tagFilter
        ? Object.values(notes)
            .filter((n) => !n.deleted && (n.tags ?? []).includes(tagFilter))
            .sort((a, b) => b.updatedAt - a.updatedAt)
        : null,
    [notes, tagFilter]
  )

  const query = search.trim()

  /* ---------------- 拖放 ---------------- */

  const clearHoverTimer = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const endDrag = useCallback(() => {
    draggingRef.current = null
    setDragging(null)
    setDrop(null)
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }, [])

  /** 真正落地：要么放进某个目录，要么排到某一项前后 */
  const commitDrop = (target: DropTarget) => {
    const payload = draggingRef.current
    endDrag()
    if (!payload) return

    if (target.position === 'inside') {
      if (!canDrop(payload, target.id, folders)) return
      if (payload.kind === 'note') void sync.moveNote(payload.id, target.id)
      else void sync.moveFolder(payload.id, target.id)
      return
    }

    // 同级排序：落到目标所在的那一层，并算出前后邻居之间的排序值
    const targetKind = target.kind === 'root' ? 'folder' : target.kind
    const targetId = target.id as string
    const parentId = parentOf({ id: targetId, kind: targetKind }, folders, notes)
    if (!canDrop(payload, parentId, folders)) return

    const siblings = siblingsOf(payload.kind, parentId, folders, notes)
    // 拖动项和目标不同类时（笔记落在目录行边缘），只取归属，排序值排到末尾
    const order =
      payload.kind === targetKind
        ? orderBetween(siblings, targetId, target.position, payload.id)
        : (siblings.at(-1)?.sortOrder ?? Date.now()) + 1000

    if (payload.kind === 'note') void sync.moveNote(payload.id, parentId, order)
    else void sync.moveFolder(payload.id, parentId, order)
  }

  const rowDropProps = (id: string, kind: 'note' | 'folder') => ({
    onDragOver: (e: React.DragEvent) => {
      const payload = draggingRef.current
      if (!payload || payload.id === id) return
      const position = positionInRow(e.clientY, e.currentTarget.getBoundingClientRect(), kind === 'folder')
      const parentId = position === 'inside' ? id : parentOf({ id, kind }, folders, notes)
      if (!canDrop(payload, parentId, folders)) return

      e.preventDefault()
      // 必须拦住冒泡：外层列表也是放置目标，它的 handler 会把这里设的高亮覆盖成「移到根层级」
      e.stopPropagation()
      // 某些来源派发的拖拽事件没有 dataTransfer，别让它把后面的状态更新带崩
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      setDrop((cur) => (cur && cur.id === id && cur.position === position ? cur : { id, kind, position }))

      // 悬停在折叠的目录中间，稍等一下自动展开，方便往深处拖
      if (kind === 'folder' && position === 'inside') {
        if (!hoverTimer.current && !useStore.getState().expanded[id]) {
          hoverTimer.current = setTimeout(() => {
            hoverTimer.current = null
            toggleExpand(id, true)
          }, HOVER_EXPAND_MS)
        }
      } else {
        clearHoverTimer()
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      e.stopPropagation()
      if (e.currentTarget.contains(e.relatedTarget as Node)) return
      clearHoverTimer()
      setDrop((cur) => (cur?.id === id ? null : cur))
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const position = positionInRow(e.clientY, e.currentTarget.getBoundingClientRect(), kind === 'folder')
      commitDrop({ id, kind, position })
    },
  })

  /** 列表空白处 = 移到根层级 */
  const rootDropProps = {
    onDragOver: (e: React.DragEvent) => {
      const payload = draggingRef.current
      if (!payload || !canDrop(payload, null, folders)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      setDrop({ id: null, kind: 'root', position: 'inside' })
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return
      setDrop((cur) => (cur?.kind === 'root' ? null : cur))
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      commitDrop({ id: null, kind: 'root', position: 'inside' })
    },
  }

  const dragProps = (payload: DragPayload) => ({
    draggable: !renaming,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(DND_MIME, JSON.stringify(payload))
      draggingRef.current = payload
      setDragging(payload)
    },
    onDragEnd: endDrag,
  })

  /* ---------------- 行渲染 ---------------- */

  const dropLine = (id: string, position: DropPosition, depth: number) =>
    drop?.id === id && drop.position === position ? (
      <div className="drop-line" style={{ marginLeft: 12 + depth * 16 }} />
    ) : null

  const noteRow = (note: Note, depth: number) => (
    <div key={note.id}>
      {dropLine(note.id, 'before', depth)}
      <NoteRow
        note={note}
        depth={depth}
        active={note.id === activeNoteId}
        dragging={dragging?.kind === 'note' && dragging.id === note.id}
        renaming={renaming === note.id}
        onStartRename={() => setRenaming(note.id)}
        onEndRename={() => setRenaming(null)}
        dragProps={dragProps({ kind: 'note', id: note.id })}
        dropProps={rowDropProps(note.id, 'note')}
        menu={menu}
      />
      {dropLine(note.id, 'after', depth)}
    </div>
  )

  const folderRow = (node: TreeNode, depth: number) => {
    const id = node.folder.id
    return (
      <div key={id}>
        {dropLine(id, 'before', depth)}
        <FolderRow
          node={node}
          depth={depth}
          dropInside={drop?.id === id && drop.position === 'inside'}
          dragging={dragging?.kind === 'folder' && dragging.id === id}
          renaming={renaming === id}
          onStartRename={() => setRenaming(id)}
          onEndRename={() => setRenaming(null)}
          dragProps={dragProps({ kind: 'folder', id })}
          dropProps={rowDropProps(id, 'folder')}
          renderChildren={() => (
            <>
              {node.children.map((child) => folderRow(child, depth + 1))}
              {node.notes.map((n) => noteRow(n, depth + 1))}
              {!node.children.length && !node.notes.length && (
                <div className="tree-empty" style={{ paddingLeft: 20 + (depth + 1) * 16 }}>
                  空目录
                </div>
              )}
            </>
          )}
          menu={menu}
        />
        {dropLine(id, 'after', depth)}
      </div>
    )
  }

  return (
    <>
      <div className="panel-head">
        <button
          className={'panel-tab' + (sidebarView === 'tree' ? ' is-active' : '')}
          onClick={() => setSidebarView('tree')}
        >
          笔记
        </button>
        <button
          className={'panel-tab' + (sidebarView === 'tags' ? ' is-active' : '')}
          onClick={() => setSidebarView('tags')}
        >
          标签
          {tagCount > 0 && <span className="panel-tab-count">{tagCount}</span>}
        </button>
        <span className="panel-head-gap" />
        {sidebarView === 'tree' && (
          <>
            <button className="icon-btn" title="导出全部为 Markdown" onClick={() => void exportAll()}>
              <IconExport size={17} />
            </button>
            <button className="icon-btn" title="新建目录" onClick={() => void sync.createFolder('新建目录')}>
              <IconFolderPlus size={18} />
            </button>
            <button className="icon-btn" title={`新建笔记 (${formatCombo(bindings.newNote)})`} onClick={() => void sync.createNote(null)}>
              <IconPlus size={18} />
            </button>
          </>
        )}
      </div>

      {sidebarView === 'tree' && (
      <div className="search-box">
        <IconSearch size={15} />
        <input
          value={search}
          placeholder="搜索笔记"
          onChange={(e) => setSearch(e.target.value)}
          aria-label="搜索笔记"
        />
        {search && (
          <button className="icon-btn search-clear" onClick={() => setSearch('')} title="清除">
            <IconClose size={13} />
          </button>
        )}
      </div>
      )}

      <div
        className={'panel-body tree' + (drop?.kind === 'root' ? ' is-root-target' : '')}
        {...rootDropProps}
      >
        {sidebarView === 'trash' ? (
          <Trash />
        ) : sidebarView === 'tags' ? (
          tagged ? (
            <>
              <div className="search-count">
                <button className="tag-back" title="返回标签列表" onClick={() => setTagFilter(null)}>
                  <IconBack size={13} className="rot-back" />
                </button>
                <span className="tag-filter-chip">
                  <IconTag size={12} />
                  {tagFilter}
                </span>
                共 {tagged.length} 篇
              </div>
              {tagged.map((n) => noteRow(n, 0))}
            </>
          ) : (
            <TagList />
          )
        ) : query ? (
          <SearchResults query={query} />
        ) : (
          <>
            {tree.map((node) => folderRow(node, 0))}
            {rootNotes.map((n) => noteRow(n, 0))}

            {!tree.length && !rootNotes.length && (
              <div className="tree-empty">
                还没有笔记。
                <br />
                点上方 ＋ 新建一篇，或先建个目录。
              </div>
            )}
          </>
        )}
      </div>

      {menu.node}
    </>
  )
}

/* ---------------- 目录行 ---------------- */

function FolderRow(props: {
  node: TreeNode
  depth: number
  dropInside: boolean
  dragging: boolean
  renaming: boolean
  onStartRename: () => void
  onEndRename: () => void
  dragProps: Record<string, unknown>
  dropProps: Record<string, unknown>
  renderChildren: () => React.ReactNode
  menu: ReturnType<typeof useContextMenu>
}) {
  const { node, depth, dropInside, dragging, renaming, dragProps, dropProps, menu } = props
  const expanded = useStore((s) => s.expanded[node.folder.id] ?? false)
  const toggleExpand = useStore((s) => s.toggleExpand)
  const count = node.notes.length + node.children.length

  const actions: (MenuAction | 'separator')[] = [
    { label: '在此新建笔记', icon: <IconNote size={16} />, onSelect: () => void sync.createNote(node.folder.id) },
    { label: '新建子目录', icon: <IconFolderPlus size={16} />, onSelect: () => void sync.createFolder('新建目录', node.folder.id) },
    'separator',
    { label: '重命名', icon: <IconPencil size={16} />, onSelect: props.onStartRename },
    {
      label: '导出这个目录',
      icon: <IconExport size={16} />,
      onSelect: () => void exportAll({ folderId: node.folder.id }),
    },
    {
      label: '删除目录',
      icon: <IconTrash size={16} />,
      danger: true,
      onSelect: () => void sync.deleteFolder(node.folder.id),
    },
  ]

  return (
    <>
      <div
        className={
          'tree-row is-folder' +
          (dropInside ? ' is-drop-inside' : '') +
          (dragging ? ' is-dragging' : '')
        }
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={() => toggleExpand(node.folder.id)}
        onContextMenu={(e) => menu.open(e, actions)}
        title={node.folder.name}
        {...dragProps}
        {...dropProps}
      >
        <span
          className={'tree-twist' + (expanded ? ' is-open' : '')}
          onClick={(e) => {
            e.stopPropagation()
            toggleExpand(node.folder.id)
          }}
        >
          <IconChevron size={14} />
        </span>
        {expanded ? (
          <IconFolderOpen size={17} className="tree-icon" />
        ) : (
          <IconFolder size={17} className="tree-icon" />
        )}
        {renaming ? (
          <RenameInput
            initial={node.folder.name}
            onCommit={(name) => {
              if (name && name !== node.folder.name) void sync.renameFolder(node.folder.id, name)
              props.onEndRename()
            }}
          />
        ) : (
          <>
            <span className="tree-label">{node.folder.name}</span>
            {count > 0 && <span className="tree-count">{count}</span>}
            <span className="tree-actions">
              <button
                className="icon-btn"
                title="在此新建笔记"
                onClick={(e) => {
                  e.stopPropagation()
                  void sync.createNote(node.folder.id)
                }}
              >
                <IconPlus size={16} />
              </button>
              <button
                className="icon-btn"
                title="更多"
                onClick={(e) => {
                  e.stopPropagation()
                  menu.openAt(e.currentTarget, actions)
                }}
              >
                <IconMore size={16} />
              </button>
            </span>
          </>
        )}
      </div>
      {expanded && props.renderChildren()}
    </>
  )
}

/* ---------------- 笔记行 ---------------- */

function NoteRow(props: {
  note: Note
  depth: number
  active: boolean
  dragging: boolean
  renaming: boolean
  onStartRename: () => void
  onEndRename: () => void
  dragProps: Record<string, unknown>
  dropProps: Record<string, unknown>
  menu: ReturnType<typeof useContextMenu>
}) {
  const { note, depth, active, dragging, renaming, dragProps, dropProps, menu } = props
  const setActive = useStore((s) => s.setActive)
  const title = note.title?.trim()

  const actions: (MenuAction | 'separator')[] = [
    { label: '重命名', icon: <IconPencil size={16} />, onSelect: props.onStartRename },
    { label: '移出目录', icon: <IconFolder size={16} />, onSelect: () => void sync.moveNote(note.id, null) },
    { label: '导出为 Markdown', icon: <IconExport size={16} />, onSelect: () => void exportNote(note) },
    'separator',
    { label: '删除笔记', icon: <IconTrash size={16} />, danger: true, onSelect: () => void sync.deleteNote(note.id) },
  ]

  return (
    <div
      className={'tree-row is-note' + (active ? ' is-active' : '') + (dragging ? ' is-dragging' : '')}
      style={{ paddingLeft: 28 + depth * 16 }}
      onClick={() => setActive(note.id)}
      onContextMenu={(e) => menu.open(e, actions)}
      title={title || '无标题'}
      {...dragProps}
      {...dropProps}
    >
      <IconNote size={16} className="tree-icon" />
      {renaming ? (
        <RenameInput
          initial={title || ''}
          onCommit={(name) => {
            if (name && name !== title) void sync.renameNote(note.id, name)
            props.onEndRename()
          }}
        />
      ) : (
        <>
          <span className={'tree-label' + (title ? '' : ' is-untitled')}>{title || '无标题'}</span>
          <span className="tree-actions">
            <button
              className="icon-btn"
              title="更多"
              onClick={(e) => {
                e.stopPropagation()
                menu.openAt(e.currentTarget, actions)
              }}
            >
              <IconMore size={16} />
            </button>
          </span>
        </>
      )}
    </div>
  )
}

function RenameInput({ initial, onCommit }: { initial: string; onCommit: (v: string) => void }) {
  return (
    <input
      className="tree-rename"
      defaultValue={initial}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') onCommit('')
      }}
    />
  )
}
