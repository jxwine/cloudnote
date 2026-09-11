import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Heading from '@tiptap/extension-heading'
import { Placeholder } from '@tiptap/extensions'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import { createLowlight } from 'lowlight'
import langJs from 'highlight.js/lib/languages/javascript'
import langTs from 'highlight.js/lib/languages/typescript'
import langPy from 'highlight.js/lib/languages/python'
import langJava from 'highlight.js/lib/languages/java'
import langGo from 'highlight.js/lib/languages/go'
import langRust from 'highlight.js/lib/languages/rust'
import langSql from 'highlight.js/lib/languages/sql'
import langBash from 'highlight.js/lib/languages/bash'
import langJson from 'highlight.js/lib/languages/json'
import langYaml from 'highlight.js/lib/languages/yaml'
import langXml from 'highlight.js/lib/languages/xml'
import langCss from 'highlight.js/lib/languages/css'
import langMd from 'highlight.js/lib/languages/markdown'

import { useStore, currentBindings } from '@/lib/store'
import { comboFromEvent, findShortcut } from '@/lib/shortcuts'
import { setLink } from '@/lib/links'
import type { Note } from '@/lib/types'
import * as sync from '@/lib/sync'
import { deriveExcerpt, deriveTitle } from '@/lib/outline'
import { useImeGuard } from '@/lib/ime'
import { SearchHighlight, applySearchTerm } from '@/lib/searchHighlight'
import { FindReplace } from './FindReplace'
import { TagBar } from './TagBar'
import { History } from './History'
import { exportNote } from '@/lib/export'
import { imagesFromDataTransfer, insertImageFiles } from '@/lib/images'
import { EditorToolbar } from './EditorToolbar'
import { BubbleToolbar } from './BubbleToolbar'
import { IconClose, IconNote, IconHistory, IconExport } from './Icons'

/** 允许交给系统浏览器打开的协议。笔记内容可能来自粘贴或另一端，javascript: 之类必须挡住 */
const SAFE_LINK = /^(https?|mailto|ftp):/i

// 只注册常用语言：全量 common 会给包体积额外加上近 1MB
/**
 * 标题快捷键换成 Alt+1 ~ 3。Tiptap 自带的是 Ctrl+Alt+数字，三个键太别扭；
 * 而且 Ctrl+Alt 在欧洲布局上等于 AltGr，会和输入特殊字符撞车。四级标题保留在结构里，只是没有键。
 */
const HeadingWithAltKeys = Heading.extend({
  addKeyboardShortcuts() {
    return Object.fromEntries(
      ([1, 2, 3] as const).map((level) => [`Alt-${level}`, () => this.editor.commands.toggleHeading({ level })])
    )
  },
})

const lowlight = createLowlight()
lowlight.register({
  javascript: langJs, typescript: langTs, python: langPy, java: langJava,
  go: langGo, rust: langRust, sql: langSql, bash: langBash,
  json: langJson, yaml: langYaml, xml: langXml, css: langCss, markdown: langMd,
})

interface Props {
  onEditorReady: (editor: Editor | null) => void
  scrollRef: React.RefObject<HTMLDivElement>
}

export function EditorPane({ onEditorReady, scrollRef }: Props) {
  const activeNoteId = useStore((s) => s.activeNoteId)
  const note = useStore((s) => {
    // 已软删的笔记按「没打开」处理：本地缓存里还留着它，但不该继续显示
    const n = s.activeNoteId ? s.notes[s.activeNoteId] : undefined
    return n && !n.deleted ? n : undefined
  })
  const dirtyNoteId = useStore((s) => s.dirtyNoteId)
  const notices = useStore((s) => s.notices)
  const applyNote = useStore((s) => s.applyNote)
  const setActive = useStore((s) => s.setActive)
  const dismissNotice = useStore((s) => s.dismissNotice)
  const search = useStore((s) => s.search)
  const searchJump = useStore((s) => s.searchJump)

  /** 编辑器里当前这份 HTML 是哪篇笔记的，用来判断远端改动要不要灌进来 */
  const applied = useRef<{ id: string; content: string } | null>(null)
  /** editorProps 里的回调拿不到还未创建的 editor，用 ref 回填 */
  const editorRef = useRef<Editor | null>(null)
  /** 查找替换条；null 表示没打开。openedAt 让每次按 Ctrl+F 都重新挂载，
   *  这样查找词会跟着当前选中的文字更新，输入框也会重新聚焦选中 */
  const [find, setFind] = useState<{ term: string; openedAt: number } | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  /** 标题输入框的即时值。远端改标题时也要跟着更新，除非正在这里打字 */
  const [titleDraft, setTitleDraft] = useState('')
  const titleRef = useRef<HTMLTextAreaElement>(null)

  /**
   * 标题独立成字段之前，它是从正文首个标题自动取的，所以旧笔记的正文里
   * 还留着那一行。不处理的话标题会显示两遍。这里把它提上去并从正文删掉——
   * 只在「笔记还没有标题」或「正文首行和标题一模一样」时才动手，
   * 其余情况一概不碰用户的正文。每篇笔记只会发生一次。
   */
  const liftTitleFromBody = (ed: Editor, note: Note): string | null => {
    const first = ed.state.doc.firstChild
    if (!first || first.type.name !== 'heading' || first.attrs.level !== 1) return null
    const text = first.textContent.trim()
    if (!text) return null
    const current = note.title?.trim() ?? ''
    if (current && current !== text) return null
    ed.commands.deleteRange({ from: 0, to: first.nodeSize })
    return text
  }

  /**
   * 标题改动：侧栏立刻反映，落库走和正文同一条防抖通道。
   * 清空标题会立刻退回正文首行——这是回到「自动跟随」的入口。
   */
  const saveTitle = (raw: string) => {
    const id = useStore.getState().activeNoteId
    const current = id ? useStore.getState().notes[id] : undefined
    if (!id || !current) return

    const ed = editorRef.current
    const content = ed?.getHTML() ?? current.content

    // 清空就让它空着，不在这儿当场重取——取标题只有 Ctrl+S 和离开笔记两个时机
    applyNote({ ...current, title: raw })
    sync.queueSave(id, { title: raw, content, excerpt: current.excerpt })
  }

  /** 标题是单行的，粘进来的换行一律压成空格 */
  const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ')
  const titleIme = useImeGuard((value) => saveTitle(oneLine(value)))

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        codeBlock: false,
        heading: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener', target: '_blank' } },
      }),
      HeadingWithAltKeys.configure({ levels: [1, 2, 3, 4] }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'heading' ? '小节标题' : "从这里开始写。输入 '## ' 分小节，'- ' 变列表",
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Image.configure({ inline: false, allowBase64: true }),
      TableKit.configure({ table: { resizable: true } }),
      CodeBlockLowlight.configure({ lowlight }),
      SearchHighlight,
    ],
    []
  )

  /**
   * 结算标题。
   *
   * 只在内容已经定下来的时刻调用：按 Ctrl+S，或者离开这篇笔记（切走、关窗）。
   *
   * 规则只有一条：标题为空才取，取到就定死。想重新取就把标题清空。
   */
  const settleTitle = useCallback(
    (ed: Editor, noteId: string) => {
      const cur = useStore.getState().notes[noteId]
      // 已经有标题了就不再动它——不管这标题是手填的还是上一次结算取来的。
      // 取一次就定死；想重新取就把标题清空，下一次结算会补上。
      if (!cur || cur.title.trim()) return

      const title = deriveTitle(ed)
      if (!title) return

      const excerpt = deriveExcerpt(ed, title)
      applyNote({ ...cur, title, excerpt })
      sync.queueSave(noteId, { title, content: ed.getHTML(), excerpt })
    },
    [applyNote]
  )

  /**
   * 正文落库：算摘要、进保存队列。
   *
   * 单独抽出来是因为它有两个触发点——正常编辑走 onUpdate，
   * 中文输入法走 compositionend（合成期间的半截拼音一律不落库）。
   */
  const commitDoc = useCallback(
    (ed: Editor) => {
      const id = useStore.getState().activeNoteId
      if (!id) return
      const html = ed.getHTML()
      applied.current = { id, content: html }

      const current = useStore.getState().notes[id]
      if (!current) return

      // 标题不在这里取。正文每敲一下都会走到这儿，那时首行是「h」「he」这种
      // 半成品，取了就等于把中间态当成了笔记名。交给 settleTitle 在 Ctrl+S
      // 或者离开这篇笔记时再算。
      const excerpt = deriveExcerpt(ed, current.title)
      if (current.excerpt !== excerpt) {
        applyNote({ ...current, excerpt })
      }
      sync.queueSave(id, { title: current.title, content: html, excerpt })
    },
    [applyNote]
  )

  /*
   * 离开这篇笔记（切走、关窗）时结算一次：这时正文已经不会再变了，取到的最准。
   * 只对还没有标题的笔记生效，已经有标题的碰都不碰。
   */
  useEffect(() => {
    const id = note?.id
    if (!id) return
    const settle = () => {
      const ed = editorRef.current
      if (ed) settleTitle(ed, id)
    }
    // 走 sync 的钩子而不是自己监听 beforeunload：直接监听会排在 sync 那个后面，
    // 结算完再没人把它落库，标题就丢了
    const off = sync.onBeforeFlush(settle)
    return () => {
      off()
      settle()
    }
  }, [note?.id, settleTitle])

  const editor = useEditor({
    extensions,
    content: '',
    autofocus: false,
    editorProps: {
      attributes: { class: 'ProseMirror', spellcheck: 'false' },
      // Ctrl / Cmd + 单击链接交给系统浏览器；不按修饰键时是普通的放光标编辑
      handleClick: (_view, _pos, event) => {
        if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false
        const href = (event.target as HTMLElement)?.closest?.('a')?.getAttribute('href')
        if (!href || !SAFE_LINK.test(href)) return false
        event.preventDefault()
        window.open(href, '_blank', 'noopener,noreferrer')
        return true
      },
      // 粘贴和拖入的图片一律走上传，不让 base64 进正文
      handlePaste: (_view, event) => {
        const files = imagesFromDataTransfer(event.clipboardData)
        if (!files.length || !editorRef.current) return false
        event.preventDefault()
        void insertImageFiles(editorRef.current, files)
        return true
      },
      handleDOMEvents: {
        // 选完词了。此刻 PM 还没把最终文本写进文档，也还没清掉 composing，
        // 所以推到下一个事件循环再落库。
        compositionend: (view) => {
          setTimeout(() => {
            if (!view.isDestroyed && editorRef.current) commitDoc(editorRef.current)
          }, 0)
          return false
        },
      },
      handleDrop: (_view, event) => {
        const files = imagesFromDataTransfer((event as DragEvent).dataTransfer)
        if (!files.length || !editorRef.current) return false
        event.preventDefault()
        void insertImageFiles(editorRef.current, files)
        return true
      },
    },
    onUpdate: ({ editor: ed }) => {
      // 拼音打到一半时 ProseMirror 也会发 update，这时正文里是「c」「ce」这种半成品。
      // 让它落库的话，无标题的笔记会被取成「c」，别的设备也会收到这份垃圾。
      // 合成结束时 handleDOMEvents.compositionend 会补一次。
      if (ed.view.composing) return
      commitDoc(ed)
    },
  })

  useEffect(() => {
    editorRef.current = editor ?? null
    onEditorReady(editor ?? null)
    return () => onEditorReady(null)
  }, [editor, onEditorReady])

  /* 切换笔记 / 接收远端热更新 */
  useEffect(() => {
    if (!editor || !note) return

    const switching = applied.current?.id !== note.id
    if (switching) {
      // 离开上一篇前先把没落库的内容送出去
      const prev = applied.current?.id
      if (prev) void sync.flushNote(prev)
      editor.commands.setContent(note.content || '', { emitUpdate: false })

      const lifted = liftTitleFromBody(editor, note)
      if (lifted !== null) {
        // 迁移改动了正文，走一次正常保存；用户按 Ctrl+Z 可以撤回
        const html = editor.getHTML()
        applied.current = { id: note.id, content: html }
        applyNote({ ...note, title: lifted, content: html })
        sync.queueSave(note.id, { title: lifted, content: html, excerpt: note.excerpt })
        setTitleDraft(lifted)
      } else {
        applied.current = { id: note.id, content: note.content }
      }

      // 明确瞬时：CSS 上这个容器是 smooth 的，平滑动画会让紧接着的定位算错位置
      scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
      return
    }

    // 同一篇笔记内容变了：只有本地没有未保存改动时才热更新，避免吞掉正在输入的字
    const isEditing = dirtyNoteId === note.id || sync.hasPending()
    if (!isEditing && note.content !== applied.current?.content) {
      const { from, to } = editor.state.selection
      editor.commands.setContent(note.content || '', { emitUpdate: false })
      const max = editor.state.doc.content.size
      try {
        editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) })
      } catch {
        /* 文档结构变化较大时光标无法还原，保持默认位置 */
      }
      applied.current = { id: note.id, content: note.content }
    }
  }, [editor, note, note?.id, note?.content, dirtyNoteId, scrollRef])

  /* 搜索时把正文里命中的地方标出来，并跳到第一处 */
  useEffect(() => {
    if (!editor || find) return // 查找条开着时由它接管高亮
    const term = search.trim()
    applySearchTerm(editor, term)
    if (!term) return

    // dispatch 是同步的，装饰这时已经在 DOM 里了。
    // 用 scrollIntoView 而不是自己算偏移：切换笔记时容器可能正处在滚动动画里，
    // 那时读到的 scrollTop 是中间值，算出来的位置会偏。
    // 瞬时而非平滑——点搜索结果是「带我过去」，不是慢慢逛。
    const hit = scrollRef.current?.querySelector('.search-hit.is-current')
    hit?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [editor, search, searchJump, note?.id, scrollRef, find])

  /* 标题框跟着笔记走；正在这儿打字时不要打断 */
  const shownNoteId = useRef<string | null>(null)
  useEffect(() => {
    if (!note) {
      shownNoteId.current = null
      setTitleDraft('')
      return
    }
    // 换了一篇笔记就无条件同步。光标可能还停在标题框里（比如刚改完标题就点了
    // 别的笔记），这时也必须换掉，否则框里会一直显示上一篇的标题，接着打字
    // 等于把上一篇的名字写进这一篇。
    const switched = shownNoteId.current !== note.id
    shownNoteId.current = note.id

    // 同一篇之内才讲究「别打断输入」。框是空的就没什么可打断——清空标题后
    // 按 Ctrl+S 重新取到的那个值，得让它显示出来。
    if (switched || document.activeElement !== titleRef.current || !titleDraft) {
      setTitleDraft(note.title ?? '')
    }
  }, [note?.id, note?.title, note, titleDraft])

  /* 新建的空笔记：光标直接落在标题上，省一次点击。
   *
   * 只认笔记 id，一篇最多自动聚焦一次。依赖整个 note 对象的话，正文每敲一下
   * 都会 applyNote 产生新对象，这个 effect 就会重跑——那时笔记在 store 里还是
   * 「没标题、没正文」（正文是防抖后才写回去的），于是光标被从正文抢回标题框。 */
  const autofocused = useRef<string | null>(null)
  useEffect(() => {
    const id = note?.id
    if (!id || autofocused.current === id) return
    autofocused.current = id
    if (note.title || note.content) return
    titleRef.current?.focus()
  }, [note?.id, note])

  /* 标题框高度自适应，标题长了自动换行撑开 */
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [titleDraft, note?.id])

  /* 笔记被删除或未选中时清空编辑器 */
  useEffect(() => {
    if (!editor) return
    if (!activeNoteId || !note) {
      applied.current = null
      editor.commands.clearContent(false)
    }
  }, [editor, activeNoteId, note])

  /* 保存、查找、替换（默认 Ctrl+S / Ctrl+F / Ctrl+H，设置里可改，绑定表每次现取） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = findShortcut(currentBindings(), comboFromEvent(e))
      if (id === 'save') {
        e.preventDefault()
        // 主动保存：顺手把还没有标题的笔记结算掉，这是取标题最明确的时机
        const ed = editorRef.current
        const id = useStore.getState().activeNoteId
        if (ed && id) settleTitle(ed, id)
        void sync.flushAll().then(() => useStore.getState().showToast({ message: '已保存' }))
      } else if (id === 'link') {
        // 工具栏按钮的 tooltip 一直写着 Ctrl+K，之前其实没接上
        e.preventDefault()
        const ed = editorRef.current
        if (ed && useStore.getState().activeNoteId) void setLink(ed)
      } else if (id === 'find' || id === 'replace') {
        e.preventDefault()
        // 有选中文字就直接拿来当查找词，省一次输入
        const ed = editorRef.current
        const sel = ed ? ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to, ' ') : ''
        setFind({ term: sel.trim().slice(0, 80), openedAt: Date.now() })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settleTitle])

  /* 换一篇笔记就把查找条收起来，免得停在上一篇的查找词上 */
  useEffect(() => setFind(null), [note?.id])

  if (!note) {
    return (
      <div className="editor-pane">
        <div className="empty-state">
          <IconNote size={26} />
          <h2>没有打开的笔记</h2>
          <p>从左侧选一篇，或者新建一篇开始写。</p>
          <button className="btn-primary" onClick={() => void sync.createNote(null)}>
            新建笔记
          </button>
        </div>
      </div>
    )
  }

  const noteNotices = notices.filter((n) => n.noteId === note.id)

  return (
    <div className="editor-pane">
      <EditorToolbar editor={editor} />
      <BubbleToolbar editor={editor} />
      {showHistory && <History note={note} onClose={() => setShowHistory(false)} />}
      {find && (
        <FindReplace
          key={find.openedAt}
          editor={editor}
          scrollRef={scrollRef}
          initialTerm={find.term}
          onClose={() => {
            setFind(null)
            editor?.commands.focus()
          }}
        />
      )}
      <div className="editor-scroll" ref={scrollRef}>
        <div className="editor-sheet">
          <div className="note-meta">
            <span>{formatTime(note.updatedAt)}</span>
            <span className="dot" />
            <span>{countChars(note)} 字</span>
            {note.conflictOf && (
              <>
                <span className="dot" />
                <span>冲突副本</span>
              </>
            )}
            <span className="note-meta-gap" />
            <button className="meta-action" title="历史版本" onClick={() => setShowHistory(true)}>
              <IconHistory size={14} />
              历史版本
            </button>
            <button className="meta-action" title="导出为 Markdown" onClick={() => void exportNote(note)}>
              <IconExport size={14} />
              导出
            </button>
          </div>

          <textarea
            ref={titleRef}
            className="note-title"
            value={titleDraft}
            placeholder="无标题"
            rows={1}
            spellCheck={false}
            {...titleIme.bind}
            onChange={(e) => {
              // 显示实时跟上，但落库要等输入法把词选完
              const title = oneLine(e.target.value)
              setTitleDraft(title)
              titleIme.commit(title)
            }}
            onKeyDown={(e) => {
              // 回车不换行，直接跳到正文开头接着写
              if (e.key === 'Enter') {
                e.preventDefault()
                editor?.commands.focus('start')
              }
              if (e.key === 'ArrowDown' && titleRef.current?.selectionStart === titleDraft.length) {
                e.preventDefault()
                editor?.commands.focus('start')
              }
            }}
          />

          <TagBar note={note} />

          {noteNotices.map((n) => (
            <div className="notice" key={n.copyId}>
              <div className="notice-body">
                其他设备在你编辑期间改了这篇笔记。你的内容原样保留，云端那一版已存为{' '}
                <span className="notice-link" onClick={() => setActive(n.copyId)}>
                  {n.copyTitle}
                </span>
                。
              </div>
              <button className="icon-btn" title="知道了" onClick={() => dismissNotice(n.copyId)}>
                <IconClose size={13} />
              </button>
            </div>
          ))}

          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}

function countChars(note: { title: string; excerpt: string; content: string }) {
  return note.content.replace(/<[^>]*>/g, '').replace(/\s/g, '').length
}

function formatTime(ts: number) {
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return sameDay ? `今天 ${time}` : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}
