import type { Editor } from '@tiptap/react'
import { useStore } from './store'

/**
 * 选中的文本本身就是个网址或邮箱时，把它认出来当作初始值，省得用户再敲一遍。
 * 判断收得比较紧：不含空白、且点号后面得是字母，免得把「版本 1.2」这种也当成域名。
 */
export function urlFromText(text: string): string | null {
  const s = text.trim()
  if (!s || /\s/.test(s)) return null
  if (/^(https?|mailto|ftp):/i.test(s)) return s
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return `mailto:${s}`
  if (/^www\.[^\s]+\.[a-z]{2,}/i.test(s)) return `https://${s}`
  if (/^[a-z0-9][-a-z0-9.]*\.[a-z]{2,}([/?#]\S*)?$/i.test(s)) return `https://${s}`
  return null
}

/** 插入或编辑链接。已有链接时带出原地址，否则尝试用选中的文本猜一个。 */
export async function setLink(editor: Editor) {
  const prev = editor.getAttributes('link').href as string | undefined
  const { from, to } = editor.state.selection
  const guess = prev ?? urlFromText(editor.state.doc.textBetween(from, to, ' '))

  const url = await useStore.getState().prompt({
    title: prev ? '编辑链接' : '插入链接',
    initial: guess ?? 'https://',
    placeholder: 'https://example.com',
    confirmLabel: prev ? '保存' : '插入',
    extraLabel: prev ? '移除链接' : undefined,
  })

  if (url === null) return
  if (!url) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}
