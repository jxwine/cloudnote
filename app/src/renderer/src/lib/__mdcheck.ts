// 临时的转换校验模块，验证完即删
import { htmlToMarkdown } from './markdown'

const cases: [string, string, string][] = [
  ['标题', '<h1>一级</h1><h2>二级</h2>', '# 一级\n\n## 二级'],
  ['段落与强调', '<p>普通<strong>粗</strong>和<em>斜</em>与<s>删</s></p>', '普通**粗**和*斜*与~~删~~'],
  ['行内代码', '<p>用 <code>npm run dev</code> 启动</p>', '用 `npm run dev` 启动'],
  ['链接', '<p><a href="https://x.com">名字</a></p>', '[名字](https://x.com)'],
  ['图片', '<img src="/uploads/a/b.png" alt="图">', '![图](/uploads/a/b.png)'],
  ['无序列表', '<ul><li><p>甲</p></li><li><p>乙</p></li></ul>', '- 甲\n- 乙'],
  ['有序列表', '<ol><li><p>一</p></li><li><p>二</p></li></ol>', '1. 一\n2. 二'],
  [
    '任务列表',
    '<ul data-type="taskList"><li data-checked="true"><label><input type="checkbox"></label><div><p>做完了</p></div></li><li data-checked="false"><label><input type="checkbox"></label><div><p>还没做</p></div></li></ul>',
    '- [x] 做完了\n- [ ] 还没做',
  ],
  ['引用', '<blockquote><p>引用的话</p></blockquote>', '> 引用的话'],
  ['代码块', '<pre><code class="language-js">const a = 1</code></pre>', '```js\nconst a = 1\n```'],
  ['分隔线', '<hr>', '---'],
  [
    '表格',
    '<table><tbody><tr><th><p>列A</p></th><th><p>列B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>',
    '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |',
  ],
  ['高亮与下划线', '<p><mark>高亮</mark>和<u>下划线</u></p>', '==高亮==和<u>下划线</u>'],
  ['特殊字符转义', '<p>价格 * 数量 _ 合计</p>', '价格 \\* 数量 \\_ 合计'],
  ['嵌套列表', '<ul><li><p>外</p><ul><li><p>内</p></li></ul></li></ul>', '- 外\n  - 内'],
  ['空内容', '', ''],
  ['多段落之间空行', '<p>甲</p><p>乙</p>', '甲\n\n乙'],
]

export function run(): string {
  const failed: { name: string; want: string; got: string }[] = []
  let passed = 0
  for (const [name, html, want] of cases) {
    const got = htmlToMarkdown(html)
    if (got === want) passed++
    else failed.push({ name, want, got })
  }
  return JSON.stringify({ 通过: passed, 总数: cases.length, 失败: failed }, null, 1)
}
