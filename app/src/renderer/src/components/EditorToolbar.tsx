import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { useContextMenu, type MenuAction } from './ContextMenu'
import { pickAndInsertImage } from '@/lib/images'
import { setLink } from '@/lib/links'
import { ColorPicker } from './ColorPicker'
import { useStore, useBindings } from '@/lib/store'
import { formatCombo } from '@/lib/shortcuts'
import {
  IconBold, IconItalic, IconStrike, IconCode, IconLink,
  IconList, IconListOrdered, IconTask, IconQuote, IconCodeBlock,
  IconTable, IconRule, IconHeading, IconUndo, IconRedo,
  IconUnderline, IconClearFormat, IconImage, IconUpload, IconPlus,
} from './Icons'

async function insertImageUrl(editor: Editor) {
  const src = await useStore.getState().prompt({
    title: '图片地址',
    initial: '',
    placeholder: 'https://example.com/photo.png',
    confirmLabel: '插入',
  })
  if (src) editor.chain().focus().setImage({ src }).run()
}

/** 工具栏按钮状态要跟着光标走，这里订阅编辑器事务来触发重渲染 */
function useEditorTick(editor: Editor | null) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!editor) return
    const bump = () => force((n) => n + 1)
    editor.on('transaction', bump)
    editor.on('selectionUpdate', bump)
    return () => {
      editor.off('transaction', bump)
      editor.off('selectionUpdate', bump)
    }
  }, [editor])
}

export function EditorToolbar({ editor }: { editor: Editor | null }) {
  useEditorTick(editor)
  const menu = useContextMenu()
  const bindings = useBindings()

  if (!editor) return <div className="editor-bar" />

  const btn = (
    key: string,
    title: string,
    icon: React.ReactNode,
    run: () => void,
    isOn = false,
    disabled = false
  ) => (
    <button
      key={key}
      className={'icon-btn' + (isOn ? ' is-on' : '')}
      title={title}
      aria-label={title}
      aria-pressed={isOn}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
    </button>
  )

  const headingActions: MenuAction[] = [
    { label: '正文', shortcut: 'Ctrl+Alt+0', onSelect: () => editor.chain().focus().setParagraph().run() },
    { label: '标题 1', shortcut: 'Ctrl+Alt+1', onSelect: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: '标题 2', shortcut: 'Ctrl+Alt+2', onSelect: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '标题 3', shortcut: 'Ctrl+Alt+3', onSelect: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: '标题 4', shortcut: 'Ctrl+Alt+4', onSelect: () => editor.chain().focus().toggleHeading({ level: 4 }).run() },
  ]

  const insertActions: (MenuAction | 'separator')[] = [
    { label: '上传图片…', icon: <IconUpload size={15} />, onSelect: () => pickAndInsertImage(editor) },
    { label: '插入图片链接', icon: <IconImage size={15} />, onSelect: () => void insertImageUrl(editor) },
    'separator',
    { label: '表格', icon: <IconTable size={15} />, onSelect: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { label: '代码块', icon: <IconCodeBlock size={15} />, onSelect: () => editor.chain().focus().toggleCodeBlock().run() },
    { label: '分隔线', icon: <IconRule size={15} />, onSelect: () => editor.chain().focus().setHorizontalRule().run() },
  ]

  return (
    <div className="editor-bar" role="toolbar" aria-label="编辑工具">
      {btn('clear', '清除格式', <IconClearFormat />, () =>
        editor.chain().focus().unsetAllMarks().clearNodes().run()
      )}

      <span className="bar-divider" />

      {btn('undo', '撤销 (Ctrl+Z)', <IconUndo />, () => editor.chain().focus().undo().run(), false, !editor.can().undo())}
      {btn('redo', '重做 (Ctrl+Y)', <IconRedo />, () => editor.chain().focus().redo().run(), false, !editor.can().redo())}

      <span className="bar-divider" />

      <button
        className={'icon-btn' + (editor.isActive('heading') ? ' is-on' : '')}
        title="标题级别"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => menu.openAt(e.currentTarget, headingActions)}
      >
        <IconHeading />
      </button>
      {btn('bold', '加粗 (Ctrl+B)', <IconBold />, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
      {btn('italic', '斜体 (Ctrl+I)', <IconItalic />, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
      {btn('underline', '下划线 (Ctrl+U)', <IconUnderline />, () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'))}
      {btn('strike', '删除线', <IconStrike />, () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}
      <ColorPicker editor={editor} kind="text" />
      <ColorPicker editor={editor} kind="highlight" />
      {btn('code', '行内代码', <IconCode />, () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
      {btn('link', `链接 (${formatCombo(bindings.link)})`, <IconLink />, () => void setLink(editor), editor.isActive('link'))}

      <span className="bar-divider" />

      {btn('ul', '无序列表', <IconList />, () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      {btn('ol', '有序列表', <IconListOrdered />, () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {btn('task', '待办列表', <IconTask />, () => editor.chain().focus().toggleTaskList().run(), editor.isActive('taskList'))}
      {btn('quote', '引用', <IconQuote />, () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}

      <span className="bar-divider" />

      <button
        className="icon-btn"
        title="插入图片、表格、代码块"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => menu.openAt(e.currentTarget, insertActions)}
      >
        <IconPlus />
      </button>

      {menu.node}
    </div>
  )
}
