import type { Editor } from '@tiptap/react'
import { api, fileUrl } from './api'
import { useStore } from './store'

const MAX_BYTES = 10 * 1024 * 1024
const OK_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif)$/i

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })

/**
 * 图片一律先上传再插入链接，不把 base64 塞进正文——
 * 内嵌会让笔记体积暴涨，每次保存都要把整张图重新传一遍。
 */
export async function insertImageFiles(editor: Editor, files: File[]) {
  const usable = files.filter((f) => OK_TYPES.test(f.type))
  if (!usable.length) return

  const store = useStore.getState()
  for (const file of usable) {
    if (file.size > MAX_BYTES) {
      store.showToast({ message: `「${file.name}」超过 10MB，没有插入` })
      continue
    }
    try {
      store.showToast({ message: `正在上传 ${file.name}…` })
      const dataUrl = await readAsDataUrl(file)
      const { url } = await api.upload(dataUrl)
      editor.chain().focus().setImage({ src: fileUrl(url), alt: file.name }).run()
      store.hideToast()
    } catch (err) {
      store.showToast({
        message: err instanceof Error ? `上传失败：${err.message}` : '上传失败',
      })
    }
  }
}

/** 弹系统文件选择框，选完直接插入 */
export function pickAndInsertImage(editor: Editor) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = () => {
    const files = Array.from(input.files || [])
    if (files.length) void insertImageFiles(editor, files)
  }
  input.click()
}

/** 从剪贴板或拖放事件里挑出图片文件 */
export function imagesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const item of Array.from(dt.items || [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && OK_TYPES.test(file.type)) out.push(file)
  }
  if (!out.length) {
    for (const file of Array.from(dt.files || [])) {
      if (OK_TYPES.test(file.type)) out.push(file)
    }
  }
  return out
}
