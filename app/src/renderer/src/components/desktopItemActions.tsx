import { exportAll, exportNote } from '@/lib/export'
import { blockedLock } from '@/lib/readingLock'
import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'
import type { LockTarget } from '@/lib/types'
import type { MenuAction } from './ContextMenu'
import { IconExport, IconFolder, IconFolderPlus, IconNote, IconPencil, IconTrash } from './Icons'
import { readingLockMenuActions } from './ReadingLock'

/** 左侧栏和最近页使用同一套命令。菜单打开后同步也可能改变目标。 */
export function desktopItemActions(target: LockTarget, onRename: () => void): (MenuAction | 'separator')[] {
  const { id, kind } = target
  const userId = useStore.getState().user?.id
  const locked = !!blockedLock(useStore.getState(), target)
  const guard = (run: () => void, requiresRead = true) => () => {
    const current = useStore.getState()
    const item = kind === 'folder' ? current.folders[id] : current.notes[id]
    if (current.user?.id !== userId || !item || item.deleted || (requiresRead && blockedLock(current, target))) return
    run()
  }
  const lockActions = readingLockMenuActions(target).map((action) => ({
    ...action,
    onSelect: guard(() => {
      readingLockMenuActions(target).find((current) => current.label === action.label && !current.disabled)?.onSelect()
    }, false),
  }))
  const rename = { disabled: locked, label: '重命名', icon: <IconPencil size={16} />, onSelect: guard(onRename) }

  if (kind === 'folder') {
    return [
      ...lockActions,
      'separator',
      { disabled: locked, label: '在此新建笔记', icon: <IconNote size={16} />, onSelect: guard(() => void sync.createNote(id)) },
      { disabled: locked, label: '新建子目录', icon: <IconFolderPlus size={16} />, onSelect: guard(() => void sync.createFolder('新建目录', id)) },
      'separator',
      rename,
      { disabled: locked, label: '导出这个目录', icon: <IconExport size={16} />, onSelect: guard(() => void exportAll({ folderId: id })) },
      { disabled: locked, label: '删除目录', icon: <IconTrash size={16} />, danger: true, onSelect: guard(() => void sync.deleteFolder(id)) },
    ]
  }

  return [
    ...lockActions,
    'separator',
    rename,
    { disabled: locked, label: '移出目录', icon: <IconFolder size={16} />, onSelect: guard(() => void sync.moveNote(id, null)) },
    { disabled: locked, label: '导出', icon: <IconExport size={16} />, onSelect: guard(() => void exportNote(useStore.getState().notes[id])) },
    'separator',
    { disabled: locked, label: '删除笔记', icon: <IconTrash size={16} />, danger: true, onSelect: guard(() => void sync.deleteNote(id)) },
  ]
}
