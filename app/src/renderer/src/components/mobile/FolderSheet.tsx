import { useMemo } from 'react'
import { useStore, buildTree, type TreeNode } from '@/lib/store'
import * as sync from '@/lib/sync'
import { useContextMenu } from '../ContextMenu'
import { IconFolder, IconFolderPlus, IconMore, IconNote, IconTag, IconTrash } from '../Icons'

interface Props {
  /** browse：首页的目录面板，带标签 / 回收站入口和目录管理；pick：只挑一个目录（移动笔记用） */
  mode: 'browse' | 'pick'
  /** 当前所在的目录；undefined 表示现在不在目录视图（标签 / 回收站），没有一行该高亮 */
  current?: string | null
  onPick: (folderId: string | null) => void
  onView?: (view: 'tags' | 'trash') => void
  onClose: () => void
}

interface Row {
  node: TreeNode
  depth: number
  /** 含子目录的笔记数 */
  count: number
}

function flatten(tree: TreeNode[]): Row[] {
  const rows: Row[] = []
  const walk = (nodes: TreeNode[], depth: number): number => {
    let total = 0
    for (const n of nodes) {
      const row: Row = { node: n, depth, count: 0 }
      rows.push(row)
      row.count = n.notes.length + walk(n.children, depth + 1)
      total += row.count
    }
    return total
  }
  walk(tree, 0)
  return rows
}

/** 从底部滑出的目录面板 */
export function FolderSheet({ mode, current, onPick, onView, onClose }: Props) {
  const folders = useStore((s) => s.folders)
  const notes = useStore((s) => s.notes)
  const prompt = useStore((s) => s.prompt)
  const menu = useContextMenu()

  const { rows, total, trashCount } = useMemo(() => {
    const { tree, rootNotes } = buildTree(folders, notes)
    const rows = flatten(tree)
    const total = rootNotes.length + rows.filter((r) => r.depth === 0).reduce((a, r) => a + r.count, 0)
    const trashCount = Object.values(notes).filter((n) => n.deleted).length
    return { rows, total, trashCount }
  }, [folders, notes])

  const rename = async (id: string, name: string) => {
    const next = await prompt({ title: '重命名目录', initial: name, confirmLabel: '保存' })
    if (next && next.trim() && next.trim() !== name) await sync.renameFolder(id, next.trim())
  }

  const folderActions = (row: Row) => [
    {
      label: '新建子目录',
      icon: <IconFolderPlus size={15} />,
      onSelect: () => void sync.createFolder('新建目录', row.node.folder.id),
    },
    { label: '重命名', onSelect: () => void rename(row.node.folder.id, row.node.folder.name) },
    'separator' as const,
    { label: '删除目录', danger: true, onSelect: () => void sync.deleteFolder(row.node.folder.id) },
  ]

  const rowClass = (active: boolean) => 'm-sheet-row' + (active ? ' is-active' : '')

  return (
    <>
      <div className="m-sheet-backdrop" onClick={onClose} />
      <div className="m-sheet" role="dialog" aria-label={mode === 'pick' ? '移动到目录' : '目录'}>
        <div className="m-sheet-grip" />
        <div className="m-sheet-head">
          <span>{mode === 'pick' ? '移动到…' : '目录'}</span>
          {mode === 'browse' && (
            <button
              className="m-sheet-head-btn"
              aria-label="新建目录"
              onClick={() => void sync.createFolder('新建目录').then((id) => rename(id, '新建目录'))}
            >
              <IconFolderPlus size={20} />
            </button>
          )}
        </div>
        <div className="m-sheet-body">
          <button className={rowClass(current === null) + ' is-all'} onClick={() => onPick(null)}>
            <IconNote size={18} className="m-sheet-icon" />
            <span className="m-sheet-label">{mode === 'pick' ? '根目录' : '所有笔记'}</span>
            {mode === 'browse' && <span className="m-sheet-count">{total}</span>}
          </button>

          {rows.length > 0 && <div className="m-sheet-section">目录</div>}
          {rows.length === 0 && mode === 'browse' && (
            <div className="m-sheet-hint">还没有目录，点右上角新建一个</div>
          )}
          {rows.map((r) => (
            <div key={r.node.folder.id} className={rowClass(current === r.node.folder.id)}>
              <button
                className="m-sheet-main"
                style={{ paddingLeft: 16 + r.depth * 18 }}
                onClick={() => onPick(r.node.folder.id)}
              >
                <IconFolder size={18} className="m-sheet-icon" />
                <span className="m-sheet-label">{r.node.folder.name}</span>
                <span className="m-sheet-count">{r.count}</span>
              </button>
              {mode === 'browse' && (
                <button
                  className="m-sheet-more"
                  aria-label="更多"
                  onClick={(e) => menu.openAt(e.currentTarget, folderActions(r))}
                >
                  <IconMore size={18} />
                </button>
              )}
            </div>
          ))}

          {mode === 'browse' && (
            <>
              <div className="m-sheet-sep" />
              <button className="m-sheet-row" onClick={() => onView?.('tags')}>
                <IconTag size={18} className="m-sheet-icon" />
                <span className="m-sheet-label">标签</span>
              </button>
              <button className="m-sheet-row" onClick={() => onView?.('trash')}>
                <IconTrash size={18} className="m-sheet-icon" />
                <span className="m-sheet-label">回收站</span>
                {trashCount > 0 && <span className="m-sheet-count">{trashCount}</span>}
              </button>
            </>
          )}
        </div>
      </div>
      {menu.node}
    </>
  )
}
