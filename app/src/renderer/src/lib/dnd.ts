import type { Folder, Note } from './types'

export type DragKind = 'note' | 'folder'
export type DropPosition = 'before' | 'after' | 'inside'

export interface DragPayload {
  kind: DragKind
  id: string
}

export interface DropTarget {
  /** 目录 id；根层级用 null */
  id: string | null
  kind: DragKind | 'root'
  position: DropPosition
}

/** 有排序值和父级的条目，目录和笔记都能套进来 */
export interface Sortable {
  id: string
  sortOrder: number
  updatedAt: number
}

/**
 * 光标落在行的哪个部位决定意图：
 * 贴上下边缘是「排到它前面 / 后面」，落在中间是「放进这个目录里」。
 * 笔记装不下别的东西，所以只分上下两半。
 */
export function positionInRow(clientY: number, rect: DOMRect, isFolder: boolean): DropPosition {
  const y = clientY - rect.top
  if (!isFolder) return y < rect.height / 2 ? 'before' : 'after'
  const edge = Math.max(6, rect.height * 0.3)
  if (y < edge) return 'before'
  if (y > rect.height - edge) return 'after'
  return 'inside'
}

/** 目录不能拖进自己的子树，否则整棵子树会从视图里消失 */
export function canDrop(
  payload: DragPayload,
  targetFolderId: string | null,
  folders: Record<string, Folder>
): boolean {
  if (payload.kind === 'note') return true
  if (payload.id === targetFolderId) return false
  let cursor = targetFolderId
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === payload.id) return false
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = folders[cursor]?.parentId ?? null
  }
  return true
}

export const bySortOrder = <T extends Sortable>(a: T, b: T) =>
  a.sortOrder === b.sortOrder ? b.updatedAt - a.updatedAt : a.sortOrder - b.sortOrder

/**
 * 算出插到目标前面/后面该用什么排序值：取前后两个邻居的中点。
 * 落在两端时往外让出一整格，后面还能继续插。
 */
export function orderBetween<T extends Sortable>(
  siblings: T[],
  targetId: string,
  position: 'before' | 'after',
  movingId: string
): number {
  const list = siblings.filter((s) => s.id !== movingId).sort(bySortOrder)
  const idx = list.findIndex((s) => s.id === targetId)
  if (idx === -1) return (list.at(-1)?.sortOrder ?? Date.now()) + 1000

  const prev = position === 'before' ? list[idx - 1] : list[idx]
  const next = position === 'before' ? list[idx] : list[idx + 1]
  if (!prev) return next.sortOrder - 1000
  if (!next) return prev.sortOrder + 1000
  return (prev.sortOrder + next.sortOrder) / 2
}

/** 反复对半插会耗尽浮点精度，间隔小到这个程度就该把整层重新编号了 */
export const ORDER_EPSILON = 0.0001

export function needsRenumber<T extends Sortable>(siblings: T[]): boolean {
  const list = [...siblings].sort(bySortOrder)
  for (let i = 1; i < list.length; i++) {
    if (Math.abs(list[i].sortOrder - list[i - 1].sortOrder) < ORDER_EPSILON) return true
  }
  return false
}

/** 取某个父级下的同类兄弟，用来算排序值 */
export function siblingsOf(
  kind: DragKind,
  parentId: string | null,
  folders: Record<string, Folder>,
  notes: Record<string, Note>
): Sortable[] {
  if (kind === 'folder') {
    return Object.values(folders).filter((f) => !f.deleted && (f.parentId ?? null) === parentId)
  }
  return Object.values(notes).filter((n) => !n.deleted && (n.folderId ?? null) === parentId)
}

/** 目标条目所在的父级：目录看 parentId，笔记看 folderId */
export function parentOf(
  target: { id: string; kind: DragKind },
  folders: Record<string, Folder>,
  notes: Record<string, Note>
): string | null {
  return target.kind === 'folder'
    ? (folders[target.id]?.parentId ?? null)
    : (notes[target.id]?.folderId ?? null)
}
