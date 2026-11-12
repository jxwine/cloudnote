/** 真实 Chromium DOM 转换后检查 DOCX ZIP/XML，不依赖 Office 安装。 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { unzipSync, strFromU8 } from 'fflate'
import { attach, until } from './cdp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'cloudnote-word-'))
const profile = join(temp, 'profile')
let chrome, dev
const bundle = await build({ entryPoints: [join(here, '../src/renderer/src/lib/word.ts')],
  bundle: true, write: false, format: 'iife', globalName: 'WordExport', platform: 'browser' })
const server = createServer((req, res) => {
  if (req.url === '/word.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents) }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script src="/word.js"></script>') }
})
try {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${server.address().port}`
  const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find((candidate) => candidate && existsSync(candidate))
  if (!executable) throw new Error('找不到 Chrome，可用 CHROME_PATH 指定')
  chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, url], { stdio: 'ignore', windowsHide: true })
  const portFile = join(profile, 'DevToolsActivePort')
  await until(() => existsSync(portFile), { what: 'Word 测试浏览器启动' })
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
  await until(async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json())
    return pages.some((page) => page.type === 'page' && page.url.startsWith(url))
  }, { what: 'Word 测试页面' })
  dev = await attach(port, { name: 'Word 转换', urlPart: url })
  await until(() => dev.evaluate(() => !!window.WordExport), { what: 'Word 转换模块加载' })
  const result = await dev.evaluate(async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV0sAAAAASUVORK5CYII='
    const note = { title: '中文标题 & <转义>', tags: ['工作', '导出'], content: `
      <h1>中文标题 &amp; &lt;转义&gt;</h1>
      <p style="text-align:center"><strong>粗体</strong><em>斜体</em><u>下划线</u><s>删除线</s><mark>高亮</mark>
        <span style="color:rgb(255,0,0);font-size:20px">红色大字</span><br>下一行</p>
      <h2>二级标题</h2><blockquote><p>引用内容</p></blockquote><pre><code>第一行\n第二行</code></pre>
      <ol start="3"><li><p>有序第三项</p><ul><li><p>嵌套项目</p></li></ul></li></ol>
      <ul data-type="taskList"><li data-checked="true"><label><input type="checkbox"></label><div><p>完成任务</p></div></li></ul>
      <table><tr><th colspan="2"><p>表头合并</p></th></tr><tr><td rowspan="2"><p>纵向合并</p></td><td><p>单元格甲</p></td></tr><tr><td><p>单元格乙</p></td></tr></table>
      <p><a href="https://example.com/a?x=1&amp;y=2">安全链接</a><a href="javascript:alert(1)">不可执行链接</a></p>
      <p><img src="${png}" alt="内嵌图片"><img src="/missing-image" alt="失效图片"></p>
      <script>window.UNSAFE_EXECUTED=true</script>` }
    const bytes = await window.WordExport.notesToWord([{ note, path: '项目/中文标题.docx' },
      { note: { title: '第二篇', content: '<p>第二篇内容</p>', tags: [] }, path: '项目/第二篇.docx' }])
    if (window.UNSAFE_EXECUTED) throw new Error('转换执行了原始 HTML 脚本')
    const encoded = (data) => {
      let binary = ''
      for (const byte of data) binary += String.fromCharCode(byte)
      return btoa(binary)
    }
    const single = { title: '唯一笔记', content: '<p>独立正文</p>', tags: [] }
    return { bulk: encoded(bytes),
      oneBulk: encoded(await window.WordExport.notesToWord([{ note: single, path: '唯一目录/唯一笔记.docx' }])),
      single: encoded(await window.WordExport.notesToWord([{ note: single }])) }
  })
  const bytes = Buffer.from(result.bulk, 'base64')
  assert.equal(bytes.subarray(0, 2).toString(), 'PK', '必须是标准 ZIP 文件')
  const files = unzipSync(bytes)
  const xml = strFromU8(files['word/document.xml'])
  const rels = strFromU8(files['word/_rels/document.xml.rels'])
  const numbering = strFromU8(files['word/numbering.xml'])
  for (const text of ['中文标题 &amp; &lt;转义&gt;', '粗体', '斜体', '下划线', '删除线', '完成任务', '嵌套项目',
    '表头合并', '纵向合并', '单元格甲', '单元格乙', '第二篇内容', '图片未嵌入：失效图片', '目录：项目/', '标签：#工作 #导出']) assert.ok(xml.includes(text), text)
  assert.equal(xml.split('中文标题 &amp; &lt;转义&gt;').length - 1, 1, '同名一级标题不得重复')
  assert.match(xml, /w:pageBreakBefore/, '第二篇应分页')
  assert.match(xml, /w:gridSpan w:val="2"/, '保留横向合并')
  assert.match(xml, /w:vMerge/, '保留纵向合并')
  assert.match(xml, /w:color w:val="ff0000"/i, '保留文本颜色')
  assert.match(xml, /w:sz w:val="30"/, '20px 转换为 15pt')
  assert.match(xml, /w:jc w:val="center"/, '保留段落居中')
  assert.match(xml, /w:br/, '保留换行')
  assert.match(numbering, /w:start w:val="3"/, '保留有序列表起始值')
  assert.match(rels, /https:\/\/example.com\/a\?x=1&amp;y=2/, '保留安全超链接')
  assert.ok(!rels.includes('javascript:'), '过滤危险链接')
  assert.ok(!xml.includes('altChunk'), '禁止使用 Office 专有 HTML 导入')
  assert.ok(Object.keys(files).some((name) => name.startsWith('word/media/') && name.endsWith('.png')), '图片应嵌入文档')
  assert.ok(!xml.includes('UNSAFE_EXECUTED'), '脚本内容不得进入文档')
  const oneBulk = strFromU8(unzipSync(Buffer.from(result.oneBulk, 'base64'))['word/document.xml'])
  const single = strFromU8(unzipSync(Buffer.from(result.single, 'base64'))['word/document.xml'])
  assert.ok(oneBulk.includes('目录：唯一目录/唯一笔记.docx'), '批量范围恰好一篇也应显示目录')
  assert.ok(!single.includes('目录：'), '单篇导出不额外显示目录')
  if (process.env.WORD_TEST_OUTPUT) writeFileSync(process.env.WORD_TEST_OUTPUT, bytes)
  console.log('PASS: Word 标准包、中文转义、分页、标签、排版、嵌套列表、任务、合并表格、链接、图片及单篇路径回归')
} finally {
  if (dev) {
    await Promise.race([dev.send('Browser.close').catch(() => {}), new Promise((ok) => setTimeout(ok, 2000))])
    dev.close()
  }
  chrome?.kill()
  await new Promise((ok) => server.close(ok))
  // 仅清理这次创建、且已确认在系统临时目录内的隔离浏览器目录。
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) {
    try { rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
  }
}
