import { useEffect, useState } from 'react'
import { BubbleMenu } from '@tiptap/react/menus'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { setLink } from '@/lib/links'
import { useContextMenu, type MenuAction } from './ContextMenu'
import { ColorPicker } from './ColorPicker'
import {
  IconBold, IconItalic, IconStrike, IconUnderline, IconCode, IconLink,
  IconClearFormat, IconChevronDown,
} from './Icons'

/** 选中文字时浮出的格式条：只放最常用的几项，避免挡住正文 */
export function BubbleToolbar({ editor }: { editor: Editor | null }) {
  const menu = useContextMenu()
  const [, force] = useState(0)
  /** 浮动条不能越出编辑区，否则会盖住侧栏的宽度拖拽线 */
  const [boundary, setBoundary] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setBoundary(document.querySelector<HTMLElement>('.editor-scroll'))
  }, [editor])

  /**
   * 浮动条是按选区定位的，编辑区宽度一变（拖侧栏、折叠侧栏、缩窗口）它不会自己跟着动，
   * 就可能压到侧栏的拖拽线上。BubbleMenu 只在选区变化时重算位置——空事务和 window
   * resize 都推不动它——所以尺寸变化期间先把它藏起来，等稳定下来把选区折叠一下再恢复，
   * 逼它重新定位。只动选区不改文档，不会触发保存。
   */
  useEffect(() => {
    if (!editor || !boundary) return
    let timer: ReturnType<typeof setTimeout>
    let first = true
    const ro = new ResizeObserver(() => {
      // ResizeObserver 挂上时会立刻回调一次，那次不是真的尺寸变化
      if (first) {
        first = false
        return
      }
      document.body.classList.add('is-reflowing')
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!editor.isDestroyed) {
          const { from, to } = editor.state.selection
          if (from !== to) {
            editor.commands.setTextSelection({ from, to: from })
            requestAnimationFrame(() => {
              if (!editor.isDestroyed) editor.commands.setTextSelection({ from, to })
              document.body.classList.remove('is-reflowing')
            })
            return
          }
        }
        document.body.classList.remove('is-reflowing')
      }, 160)
    })
    ro.observe(boundary)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
      document.body.classList.remove('is-reflowing')
    }
  }, [editor, boundary])

  // 等 boundary 拿到再挂 BubbleMenu：插件的定位配置在创建时读一次就固定了，
  // 那时若 boundary 还是 null，shift 就没有边界可依，浮动条会被推出编辑区
  if (!editor || !boundary) return null

  const blockLabel = editor.isActive('heading', { level: 1 })
    ? '标题 1'
    : editor.isActive('heading', { level: 2 })
      ? '标题 2'
      : editor.isActive('heading', { level: 3 })
        ? '标题 3'
        : editor.isActive('heading', { level: 4 })
          ? '标题 4'
          : editor.isActive('bulletList')
            ? '项目符号'
            : editor.isActive('orderedList')
              ? '编号列表'
              : editor.isActive('blockquote')
                ? '引用'
                : '正文'

  const blockActions: MenuAction[] = [
    { label: '正文', onSelect: () => editor.chain().focus().setParagraph().run() },
    { label: '标题 1', onSelect: () => editor.chain().focus().setHeading({ level: 1 }).run() },
    { label: '标题 2', onSelect: () => editor.chain().focus().setHeading({ level: 2 }).run() },
    { label: '标题 3', onSelect: () => editor.chain().focus().setHeading({ level: 3 }).run() },
    { label: '标题 4', onSelect: () => editor.chain().focus().setHeading({ level: 4 }).run() },
    { label: '项目符号', onSelect: () => editor.chain().focus().toggleBulletList().run() },
    { label: '编号列表', onSelect: () => editor.chain().focus().toggleOrderedList().run() },
    { label: '引用', onSelect: () => editor.chain().focus().toggleBlockquote().run() },
  ]

  const btn = (title: string, icon: React.ReactNode, run: () => void, on = false) => (
    <button
      className={'bubble-btn' + (on ? ' is-on' : '')}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        run()
        force((n) => n + 1)
      }}
    >
      {icon}
    </button>
  )

  return (
    <>
      <BubbleMenu
        editor={editor}
        // 默认 250ms 的节流会把下面「折叠选区再恢复」的往返吃掉，导致位置不刷新
        updateDelay={0}
        options={{
          placement: 'top',
          offset: 10,
          flip: { padding: 8 },
          // 贴住编辑区边界，留 14px 余量，别压到左右两侧的拖拽手柄上
          shift: { padding: 14, boundary },
        }}
        shouldShow={({ editor: ed, state, from, to }) => {
          // 只在真正选中了文字时出现；选中图片、表格等节点时不打扰。
          // Ctrl / Cmd + 单击会被 ProseMirror 解释成「选中整个节点」，那不是在选文字，别弹
          if (!(state.selection instanceof TextSelection)) return false
          if (from === to) return false
          if (ed.isActive('codeBlock') || ed.isActive('image')) return false
          // 编辑区比浮动条还窄时怎么摆都会溢出去压到拖拽线，这时交给顶部工具栏
          if (boundary.clientWidth < 400) return false
          return ed.state.doc.textBetween(from, to, ' ').trim().length > 0
        }}
      >
        <div className="bubble-bar">
          {btn('清除格式', <IconClearFormat />, () =>
            editor.chain().focus().unsetAllMarks().clearNodes().run()
          )}

          <span className="bubble-sep" />

          <button
            className="bubble-block"
            title="段落格式"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => menu.openAt(e.currentTarget, blockActions)}
          >
            {blockLabel}
            <IconChevronDown size={12} />
          </button>

          <span className="bubble-sep" />

          {btn('加粗', <IconBold />, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
          {btn('斜体', <IconItalic />, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
          {btn('下划线', <IconUnderline />, () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'))}
          {btn('删除线', <IconStrike />, () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}

          <ColorPicker editor={editor} kind="text" variant="bubble" />
          <ColorPicker editor={editor} kind="highlight" variant="bubble" />

          <span className="bubble-sep" />

          {btn('行内代码', <IconCode />, () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
          {btn('链接', <IconLink />, () => void setLink(editor), editor.isActive('link'))}
        </div>
      </BubbleMenu>
      {menu.node}
    </>
  )
}
