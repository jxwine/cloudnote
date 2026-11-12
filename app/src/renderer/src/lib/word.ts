import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun,
  LevelFormat, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun,
  UnderlineType, WidthType,
} from 'docx'
import type { IParagraphOptions, IRunOptions, INumberingOptions, ParagraphChild } from 'docx'
import type { Note } from './types'

type Entry = { note: Note; path?: string }
type Block = Paragraph | Table
type Context = { depth: number; quote?: boolean; code?: boolean; bold?: boolean }
type Picture = { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp'; width: number; height: number }
const OMIT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'NOSCRIPT', 'LABEL', 'INPUT'])
const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR'])
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]

function safeLink(raw: string | null): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw, location.href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

function color(raw: string): string | undefined {
  if (/^#[\da-f]{6}$/i.test(raw)) return raw.slice(1)
  if (/^#[\da-f]{3}$/i.test(raw)) return raw.slice(1).split('').map((c) => c + c).join('')
  const rgb = raw.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/i)
  if (rgb) return rgb.slice(1).map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')
  return ({ yellow: 'FFFF00', red: 'FF0000', blue: '0000FF', black: '000000', white: 'FFFFFF',
    green: '008000', transparent: undefined } as Record<string, string | undefined>)[raw.toLowerCase()]
}

function runStyle(el: HTMLElement, inherited: IRunOptions): IRunOptions {
  const style = { ...inherited }
  if (el.matches('strong,b')) style.bold = true
  if (el.matches('em,i')) style.italics = true
  if (el.tagName === 'U') style.underline = { type: UnderlineType.SINGLE }
  if (el.matches('s,del,strike')) style.strike = true
  if (el.tagName === 'CODE') style.font = 'Consolas'
  if (el.tagName === 'SUB') style.subScript = true
  if (el.tagName === 'SUP') style.superScript = true
  const foreground = color(el.style.color)
  if (foreground) style.color = foreground
  const background = color(el.style.backgroundColor) || (el.tagName === 'MARK' ? 'FFFF00' : undefined)
  if (background) style.shading = { type: ShadingType.CLEAR, fill: background }
  const size = el.style.fontSize.match(/^([\d.]+)(px|pt)$/)
  if (size) style.size = Math.max(2, Math.min(400, Number(size[1]) * (size[2] === 'px' ? 1.5 : 2)))
  return style
}

/** 图片先下载并嵌入，不让 Office 打开导出文档时再访问笔记服务器。 */
async function picture(src: string): Promise<Picture | null> {
  let objectUrl = ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const url = new URL(src, location.href)
    if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return null
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) return null
    const blob = await response.blob()
    if (!blob.size || blob.size > 10 * 1024 * 1024 || !blob.type.startsWith('image/')) return null
    objectUrl = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      const decodeTimer = setTimeout(() => reject(new Error('图片解码超时')), 4000)
      img.onload = () => { clearTimeout(decodeTimer); resolve() }
      img.onerror = () => { clearTimeout(decodeTimer); reject(new Error('图片无法读取')) }
      img.src = objectUrl
    })
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40_000_000) return null
    const scale = Math.min(1, 600 / img.naturalWidth, 780 / img.naturalHeight)
    const width = Math.max(1, Math.round(img.naturalWidth * scale))
    const height = Math.max(1, Math.round(img.naturalHeight * scale))
    const formats: Record<string, Picture['type']> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' }
    const type = formats[blob.type.toLowerCase()]
    if (type) return { data: new Uint8Array(await blob.arrayBuffer()), type, width, height }
    // WebP/AVIF/SVG 在较旧的 Word 中支持不一致，统一栅格化为 PNG。
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, width, height)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return png ? { data: new Uint8Array(await png.arrayBuffer()), type: 'png', width, height } : null
  } catch { return null } finally {
    clearTimeout(timer)
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

/** 输出真正的 OOXML，不使用 Word 专有的 HTML/altChunk 导入。 */
export async function notesToWord(entries: Entry[]): Promise<Uint8Array> {
  const documents = entries.map(({ note }) => new DOMParser().parseFromString(note.content || '', 'text/html'))
  const images = new Map<string, Promise<Picture | null>>()
  let activeImages = 0
  const waitingImages: (() => void)[] = []
  const loadPicture = async (src: string) => {
    if (activeImages >= 4) await new Promise<void>((resolve) => waitingImages.push(resolve))
    activeImages++
    try { return await picture(src) } finally {
      activeImages--
      waitingImages.shift()?.()
    }
  }
  // 同图只取一次；限制四个并发，避免整库导出同时开启大量请求与图片解码。
  for (const doc of documents) for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src')!
    if (!images.has(src)) images.set(src, loadPicture(src))
  }
  const numbering: NonNullable<INumberingOptions['config']>[number][] = []

  async function inline(node: Node, style: IRunOptions = {}): Promise<ParagraphChild[]> {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || ''
      if (style.font !== 'Consolas') return [new TextRun({ ...style, text })]
      return text.split('\n').flatMap((line, i) => [
        ...(i ? [new TextRun({ break: 1 })] : []), new TextRun({ ...style, text: line }),
      ])
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return []
    const el = node as HTMLElement
    if (OMIT.has(el.tagName)) return []
    if (el.tagName === 'BR') return [new TextRun({ break: 1 })]
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || ''
      const image = await images.get(src)
      if (image) return [new ImageRun({ data: image.data, type: image.type,
        transformation: { width: image.width, height: image.height }, altText: {
          name: el.getAttribute('alt') || '笔记图片', title: el.getAttribute('alt') || '笔记图片', description: '笔记图片',
        } })]
      const label = new TextRun({ ...style, text: `[图片未嵌入：${el.getAttribute('alt') || '图片'}]` })
      const link = safeLink(src)
      return link ? [label, new ExternalHyperlink({ link, children: [new TextRun({ text: ' 原图链接', style: 'Hyperlink' })] })] : [label]
    }
    const nextStyle = runStyle(el, style)
    const children = (await Promise.all(Array.from(el.childNodes).map((n) => inline(n, nextStyle)))).flat()
    const link = el.tagName === 'A' && safeLink(el.getAttribute('href'))
    // Tiptap 链接只含行内内容；不把可执行 scheme 写进文档关系。
    return link ? [new ExternalHyperlink({ link, children: children.filter((n): n is TextRun | ImageRun => n instanceof TextRun || n instanceof ImageRun) })] : children
  }

  function paragraphOptions(el: HTMLElement, context: Context): IParagraphOptions {
    const alignment = ({ center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED,
      left: AlignmentType.LEFT } as Record<string, IParagraphOptions['alignment']>)[el.style.textAlign]
    return {
      alignment,
      spacing: { after: 160, line: 300 },
      ...(context.quote ? { indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, color: 'BBBBBB', size: 12, space: 8 } } } : {}),
      ...(context.code ? { shading: { fill: 'F3F4F6', type: ShadingType.CLEAR } } : {}),
    }
  }

  async function paragraph(el: HTMLElement, context: Context, extra: IParagraphOptions = {}): Promise<Paragraph> {
    const style: IRunOptions = { ...(context.code ? { font: 'Consolas', size: 20 } : {}),
      ...(context.bold ? { bold: true } : {}) }
    const children = (await Promise.all(Array.from(el.childNodes).map((n) => inline(n, style)))).flat()
    return new Paragraph({ ...paragraphOptions(el, context), children, ...extra })
  }

  async function list(el: HTMLElement, context: Context): Promise<Block[]> {
    const blocks: Block[] = []
    const level = Math.min(context.depth, 8)
    const reference = `list-${numbering.length}`
    const task = el.dataset.type === 'taskList'
    if (!task) numbering.push({ reference, levels: Array.from({ length: 9 }, (_, i) => ({
      level: i, format: el.tagName === 'OL' ? LevelFormat.DECIMAL : LevelFormat.BULLET,
      text: el.tagName === 'OL' ? `%${i + 1}.` : '•', start: Math.max(1, parseInt(el.getAttribute('start') || '1', 10) || 1),
      style: { paragraph: { indent: { left: 360 * (i + 1), hanging: 240 } } },
    })) })
    for (const li of Array.from(el.children).filter((n) => n.tagName === 'LI')) {
      let first = true
      // 任务项外层 div 中也可能含嵌套列表，递归保留其块级结构。
      async function itemChildren(root: Element): Promise<void> {
        let pending: Node[] = []
        const flush = async () => {
          if (!pending.length) return
          const box = document.createElement('p')
          pending.forEach((n) => box.appendChild(n.cloneNode(true)))
          pending = []
          const children = await inline(box)
          if (first && task) children.unshift(new TextRun(li.getAttribute('data-checked') === 'true' ? '☑ ' : '☐ '))
          blocks.push(new Paragraph({ ...paragraphOptions(box, context), children,
            ...(first && !task ? { numbering: { reference, level } } : { indent: { left: 360 * (level + 1) } }) }))
          first = false
        }
        for (const node of Array.from(root.childNodes)) {
          const tag = (node as HTMLElement).tagName
          if (OMIT.has(tag)) continue
          if (tag === 'UL' || tag === 'OL') {
            await flush()
            blocks.push(...await list(node as HTMLElement, { ...context, depth: context.depth + 1 }))
          } else if (tag === 'DIV' || tag === 'P') {
            await flush()
            await itemChildren(node as Element)
          } else pending.push(node)
        }
        await flush()
      }
      await itemChildren(li)
      if (first) blocks.push(new Paragraph({ text: task ? '☐ ' : '', numbering: task ? undefined : { reference, level } }))
    }
    return blocks
  }

  async function table(el: HTMLElement, context: Context): Promise<Block[]> {
    const rows: TableRow[] = []
    // 仅取当前表格的行，嵌套表格由单元格递归处理。
    for (const tr of Array.from(el.querySelectorAll('tr')).filter((tr) => tr.closest('table') === el)) {
      const cells: TableCell[] = []
      for (const cell of Array.from(tr.children).filter((n) => ['TD', 'TH'].includes(n.tagName))) {
        const element = cell as HTMLTableCellElement
        const children = await blocksOf(element, { ...context, bold: element.tagName === 'TH' })
        if (!children.length || children[children.length - 1] instanceof Table) children.push(new Paragraph(''))
        cells.push(new TableCell({ children, columnSpan: Math.max(1, element.colSpan), rowSpan: Math.max(1, element.rowSpan),
          ...(element.tagName === 'TH' ? { shading: { fill: 'F0F2F4', type: ShadingType.CLEAR } } : {}),
          margins: { top: 80, bottom: 80, left: 100, right: 100 } }))
      }
      if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: tr.parentElement?.tagName === 'THEAD' }))
    }
    return rows.length ? [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })] : []
  }

  async function blocksOf(root: HTMLElement, context: Context): Promise<Block[]> {
    const out: Block[] = []
    let pending: Node[] = []
    const flush = async () => {
      if (!pending.length) return
      const p = document.createElement('p')
      pending.forEach((n) => p.appendChild(n.cloneNode(true)))
      pending = []
      if (p.textContent?.trim() || p.querySelector('img,br')) out.push(await paragraph(p, context))
    }
    for (const node of Array.from(root.childNodes)) {
      const el = node as HTMLElement
      if (OMIT.has(el.tagName)) continue
      if (!BLOCK.has(el.tagName)) { pending.push(node); continue }
      await flush()
      if (el.tagName === 'UL' || el.tagName === 'OL') out.push(...await list(el, context))
      else if (el.tagName === 'TABLE') out.push(...await table(el, context))
      else if (el.tagName === 'BLOCKQUOTE') out.push(...await blocksOf(el, { ...context, quote: true }))
      else if (el.tagName === 'PRE') out.push(await paragraph(el, { ...context, code: true }))
      else if (el.tagName === 'DIV') out.push(...await blocksOf(el, context))
      else if (el.tagName === 'HR') out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB' } } }))
      else out.push(await paragraph(el, context, /^H[1-6]$/.test(el.tagName) ? { heading: HEADINGS[Number(el.tagName[1]) - 1] } : {}))
    }
    await flush()
    return out
  }

  const children: Block[] = []
  for (let i = 0; i < entries.length; i++) {
    const { note, path } = entries[i]
    const body = documents[i].body
    const title = note.title.trim() || '无标题'
    // 编辑器正文可能已有同名一级标题，导出时只保留一份。
    const first = body.firstElementChild
    if (first?.tagName === 'H1' && first.textContent?.trim() === title) first.remove()
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, pageBreakBefore: i > 0 }))
    if (path) children.push(new Paragraph({ children: [new TextRun({ text: `目录：${path}`, color: '666666', size: 20 })] }))
    if (note.tags?.length) children.push(new Paragraph({ text: `标签：${note.tags.map((tag) => `#${tag}`).join(' ')}` }))
    children.push(...await blocksOf(body, { depth: 0 }))
  }
  const doc = new Document({
    creator: '云笔记', title: entries.length === 1 ? entries[0].note.title || '无标题' : '云笔记导出',
    styles: { default: { document: { run: { font: { ascii: 'Calibri', eastAsia: '宋体', hAnsi: 'Calibri' },
      size: 22, language: { value: 'zh-CN', eastAsia: 'zh-CN' } }, paragraph: { spacing: { after: 160, line: 300 } } } } },
    numbering: { config: numbering },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 },
      margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } }, children }],
  })
  return new Uint8Array(await Packer.toArrayBuffer(doc))
}
