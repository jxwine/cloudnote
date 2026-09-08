/**
 * 把编辑器产出的 HTML 转成 Markdown。
 *
 * 没有引第三方库：编辑器能产出的节点是有限且已知的一组，自己转一遍不到两百行，
 * 还能顺手照顾中文排版和任务列表这些细节。用浏览器自带的 DOM 解析，不写正则拼装。
 */

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'DIV',
])

/** Markdown 里有特殊含义的字符，出现在正文里要转义 */
function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1')
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  const inner = childrenToMarkdown(el, inline)

  switch (el.tagName) {
    case 'STRONG':
    case 'B':
      return inner.trim() ? `**${inner}**` : ''
    case 'EM':
    case 'I':
      return inner.trim() ? `*${inner}*` : ''
    case 'S':
    case 'DEL':
    case 'STRIKE':
      return inner.trim() ? `~~${inner}~~` : ''
    case 'CODE':
      // 行内代码里不转义，原样保留
      return `\`${el.textContent ?? ''}\``
    case 'A': {
      const href = el.getAttribute('href')
      return href ? `[${inner}](${href})` : inner
    }
    case 'IMG': {
      const src = el.getAttribute('src') ?? ''
      const alt = el.getAttribute('alt') ?? ''
      return src ? `![${alt}](${src})` : ''
    }
    case 'BR':
      return '  \n'
    // 下划线和高亮 Markdown 没有对应写法，退回 HTML 标签，多数渲染器认
    case 'U':
      return inner.trim() ? `<u>${inner}</u>` : ''
    case 'MARK':
      return inner.trim() ? `==${inner}==` : ''
    default:
      return inner
  }
}

function childrenToMarkdown(el: Node, fn: (n: Node) => string): string {
  return Array.from(el.childNodes).map(fn).join('')
}

function listToMarkdown(list: HTMLElement, depth: number): string {
  const ordered = list.tagName === 'OL'
  const isTaskList = list.getAttribute('data-type') === 'taskList'
  const pad = '  '.repeat(depth)

  return Array.from(list.children)
    .filter((li) => li.tagName === 'LI')
    .map((li, i) => {
      const item = li as HTMLElement
      // 任务项的结构是 <li><label><input></label><div>正文</div></li>
      let marker = ordered ? `${i + 1}. ` : '- '
      if (isTaskList) {
        const checked = item.getAttribute('data-checked') === 'true'
        marker = `- [${checked ? 'x' : ' '}] `
      }

      const nested: string[] = []
      const parts: string[] = []
      for (const child of Array.from(item.childNodes)) {
        const childEl = child as HTMLElement
        if (childEl.tagName === 'UL' || childEl.tagName === 'OL') {
          nested.push(listToMarkdown(childEl, depth + 1))
        } else if (childEl.tagName === 'LABEL') {
          // 复选框本身不进正文
        } else {
          parts.push(block(child, depth).trim())
        }
      }

      const body = parts.filter(Boolean).join('\n\n')
      return pad + marker + body + (nested.length ? '\n' + nested.join('\n') : '')
    })
    .join('\n')
}

function tableToMarkdown(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (!rows.length) return ''

  const toCells = (tr: Element) =>
    Array.from(tr.children).map((cell) => childrenToMarkdown(cell, inline).trim().replace(/\|/g, '\\|') || ' ')

  const head = toCells(rows[0])
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
  for (const tr of rows.slice(1)) lines.push(`| ${toCells(tr).join(' | ')} |`)
  return lines.join('\n')
}

function block(node: Node, depth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    return text.trim() ? escapeText(text) : ''
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  switch (el.tagName) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const level = Number(el.tagName[1])
      return `${'#'.repeat(level)} ${childrenToMarkdown(el, inline).trim()}`
    }
    case 'P':
      return childrenToMarkdown(el, inline).trim()
    case 'UL':
    case 'OL':
      return listToMarkdown(el, depth)
    case 'BLOCKQUOTE':
      return childrenToMarkdown(el, (n) => block(n, depth))
        .trim()
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n')
    case 'PRE': {
      const code = el.querySelector('code')
      // Tiptap 把语言放在 class="language-xxx" 上
      const lang = code?.className.match(/language-(\w+)/)?.[1] ?? ''
      return `\`\`\`${lang}\n${(code ?? el).textContent ?? ''}\n\`\`\``
    }
    case 'HR':
      return '---'
    case 'TABLE':
      return tableToMarkdown(el)
    case 'IMG':
      return inline(el)
    default:
      // div 之类的容器：把里面的块级内容摊平
      if (Array.from(el.childNodes).some((c) => BLOCK_TAGS.has((c as HTMLElement).tagName))) {
        return blocksOf(el, depth)
      }
      return childrenToMarkdown(el, inline).trim()
  }
}

function blocksOf(root: Node, depth = 0): string {
  return Array.from(root.childNodes)
    .map((n) => block(n, depth))
    .filter((s) => s.trim())
    .join('\n\n')
}

/** 正文 HTML → Markdown */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  return blocksOf(doc.body).replace(/\n{3,}/g, '\n\n').trim()
}

/** 导出成完整的 .md 文件内容，顶部带一小段元信息 */
export function noteToMarkdownFile(note: {
  title: string
  content: string
  tags: string[]
  updatedAt: number
}): string {
  const body = htmlToMarkdown(note.content)
  const title = note.title?.trim() || '无标题'
  // 正文本身通常已经以标题开头，避免重复
  const hasTitle = body.startsWith('# ')
  const head = hasTitle ? '' : `# ${title}\n\n`
  const tags = note.tags?.length ? `标签：${note.tags.map((t) => `#${t}`).join(' ')}\n\n` : ''
  return `${head}${tags}${body}\n`
}

/** 文件名里不能出现的字符换成短横 */
export function safeFileName(name: string): string {
  return (name.trim() || '无标题').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
}
