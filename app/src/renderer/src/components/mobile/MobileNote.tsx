import { useCallback, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'
import { EditorPane } from '../Editor'
import { Outline } from '../Outline'
import { useContextMenu } from '../ContextMenu'
import { SyncChip } from '../SyncChip'
import { FolderSheet } from './FolderSheet'
import { closeNotePage } from './MobileShell'
import { IconBack, IconList, IconMore } from '../Icons'

/**
 * 手机编辑页：顶栏（返回 / 大纲 / 更多）+ 原样的 EditorPane。
 * 标题、标签、历史版本、导出、查找都在 EditorPane 里，这里只补手机没有的入口。
 * 格式工具栏靠 CSS 挪到底部，键盘弹出时刚好贴在键盘上方。
 */
export function MobileNote() {
  const activeNoteId = useStore((s) => s.activeNoteId)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [outline, setOutline] = useState(false)
  const [move, setMove] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const menu = useContextMenu()
  const onEditorReady = useCallback((e: Editor | null) => setEditor(e), [])

  const actions = [
    { label: '移动到目录…', onSelect: () => setMove(true) },
    'separator' as const,
    {
      label: '删除笔记',
      danger: true,
      onSelect: () => {
        if (activeNoteId) void sync.deleteNote(activeNoteId)
        // deleteNote 会把 activeNoteId 清掉，MobileShell 看到编辑页没有笔记会自己退回首页；
        // 这里主动退一步，让返回键的历史也干净
        closeNotePage()
      },
    },
  ]

  return (
    <div className="m-note">
      <header className="m-top">
        <button className="m-icon" onClick={closeNotePage} aria-label="返回">
          <IconBack size={24} />
        </button>
        <SyncChip />
        <span className="m-top-gap" />
        <button className="m-icon" onClick={() => setOutline(true)} aria-label="大纲">
          <IconList size={22} />
        </button>
        <button className="m-icon" onClick={(e) => menu.openAt(e.currentTarget, actions)} aria-label="更多">
          <IconMore size={22} />
        </button>
      </header>

      <EditorPane onEditorReady={onEditorReady} scrollRef={scrollRef} />

      {outline && (
        <>
          <div className="m-sheet-backdrop" onClick={() => setOutline(false)} />
          <div className="m-sheet" role="dialog" aria-label="大纲">
            <div className="m-sheet-grip" />
            <div className="m-sheet-head">大纲</div>
            <div className="m-sheet-body m-outline">
              <Outline editor={editor} scrollRef={scrollRef} noteId={activeNoteId} onNavigate={() => setOutline(false)} />
            </div>
          </div>
        </>
      )}

      {move && activeNoteId && (
        <FolderSheet
          mode="pick"
          current={useStore.getState().notes[activeNoteId]?.folderId ?? null}
          onPick={(folderId) => {
            void sync.moveNote(activeNoteId, folderId)
            setMove(false)
          }}
          onClose={() => setMove(false)}
        />
      )}
      {menu.node}
    </div>
  )
}
