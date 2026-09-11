/**
 * 应用级快捷键。
 *
 * 组合键用字符串表示，键位取 KeyboardEvent.code 而不是 key：
 * Shift+/ 在 e.key 里是 '?'，Ctrl+Shift+/ 这种组合按 key 判永远对不上；
 * code 只认物理键位，'Slash' 就是那个键，和 Shift、输入法、键盘布局都无关。
 * 修饰键固定按 Ctrl、Alt、Shift 的顺序拼，所以同一个组合只有一种写法，能直接用字符串比较。
 *
 * 编辑器里的加粗、列表那些是 Tiptap 内置的，不在这里改；列出来只为了让用户查得到，
 * 也为了改绑时能挡住撞车。
 */

import { isDesktop } from './platform'

export type ShortcutId =
  | 'newNote'
  | 'quickJump'
  | 'toggleLeft'
  | 'toggleRight'
  | 'save'
  | 'find'
  | 'replace'
  | 'link'

export interface ShortcutDef {
  id: ShortcutId
  label: string
  hint?: string
  default: string
}

export const SHORTCUTS: ShortcutDef[] = [
  // 不用 Ctrl+N：浏览器里那是「新窗口」，Chrome 根本不把它交给页面。
  // Ctrl+D 浏览器里是收藏，但页面拦得住；两端用同一个默认，换台设备手不用重新记
  { id: 'newNote', label: '新建笔记', default: 'Ctrl+KeyD' },
  { id: 'quickJump', label: '快速跳转', hint: '按标题搜一篇笔记直接打开', default: 'Ctrl+KeyP' },
  { id: 'toggleLeft', label: '目录栏', hint: '收起 / 展开左侧目录', default: 'Ctrl+Backslash' },
  { id: 'toggleRight', label: '大纲栏', hint: '收起 / 展开右侧大纲', default: 'Ctrl+Shift+Slash' },
  { id: 'save', label: '保存', hint: '平时会自动保存，这个是立刻推一次', default: 'Ctrl+KeyS' },
  { id: 'find', label: '查找', default: 'Ctrl+KeyF' },
  { id: 'replace', label: '替换', default: 'Ctrl+KeyH' },
  { id: 'link', label: '插入链接', hint: '选中文字再按，会把文字变成链接', default: 'Ctrl+KeyK' },
]

/** 编辑器内置，只读。display 是给一组键共用一行时的显示文字 */
export const EDITOR_SHORTCUTS: { label: string; combo: string; display?: string }[] = [
  { label: '加粗', combo: 'Ctrl+KeyB' },
  { label: '斜体', combo: 'Ctrl+KeyI' },
  { label: '下划线', combo: 'Ctrl+KeyU' },
  { label: '删除线', combo: 'Ctrl+Shift+KeyS' },
  { label: '高亮', combo: 'Ctrl+Shift+KeyH' },
  { label: '行内代码', combo: 'Ctrl+KeyE' },
  { label: '标题 1 / 2 / 3', combo: 'Alt+Digit1', display: 'Alt+1 ~ 3' },
  { label: '无序列表', combo: 'Ctrl+Shift+Digit8' },
  { label: '有序列表', combo: 'Ctrl+Shift+Digit7' },
  { label: '任务列表', combo: 'Ctrl+Shift+Digit9' },
  { label: '引用', combo: 'Ctrl+Shift+KeyB' },
  { label: '代码块', combo: 'Ctrl+Alt+KeyC' },
  { label: '撤销 / 重做', combo: 'Ctrl+KeyZ', display: 'Ctrl+Z / Ctrl+Y' },
]

/** 标题 1/2/3 和 撤销/重做 各占了好几个组合，撞车检查时都要算上 */
const EDITOR_RESERVED = new Set([
  ...EDITOR_SHORTCUTS.map((s) => s.combo),
  'Alt+Digit2',
  'Alt+Digit3',
  'Ctrl+KeyY',
  'Ctrl+Shift+KeyZ',
  'Ctrl+KeyA',
  'Ctrl+Enter',
])

/**
 * 宿主自己吃掉、页面根本收不到（或者收到也拦不住）的组合。
 * 浏览器：新窗口 / 新标签 / 关标签 / 切标签这些 Chrome 在页面之前就处理了，preventDefault 无效。
 * 桌面端：Electron 默认菜单的加速键（刷新、开发者工具、缩放、最小化、关窗、退出）。
 */
const HOST_RESERVED = new Set(
  isDesktop
    ? [
        'Ctrl+KeyR', 'Ctrl+Shift+KeyR', 'Ctrl+Shift+KeyI', 'Ctrl+KeyM', 'Ctrl+KeyW', 'Ctrl+KeyQ',
        'Ctrl+Equal', 'Ctrl+Minus', 'Ctrl+Digit0', 'Ctrl+Shift+Equal',
      ]
    : [
        'Ctrl+KeyN', 'Ctrl+Shift+KeyN', 'Ctrl+KeyT', 'Ctrl+Shift+KeyT', 'Ctrl+KeyW', 'Ctrl+Shift+KeyW',
        'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+F4', 'Alt+F4', 'Ctrl+Shift+KeyQ',
      ]
)

export type ShortcutOverrides = Partial<Record<ShortcutId, string>>

/** 默认表叠上用户改过的那几条 */
export function resolveBindings(overrides: ShortcutOverrides): Record<ShortcutId, string> {
  const out = {} as Record<ShortcutId, string>
  for (const s of SHORTCUTS) out[s.id] = overrides[s.id] || s.default
  return out
}

/**
 * 从按键事件得到组合字符串。没按 Ctrl/Alt、或者只按了修饰键本身，返回 null——
 * 前者是为了别把普通打字当成快捷键，后者是录制时按住 Ctrl 还没按主键的中间态。
 * Cmd 当成 Ctrl 看，mac 上的习惯就是这样，也和以前的 ctrlKey || metaKey 一致。
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const ctrl = e.ctrlKey || e.metaKey
  if (!ctrl && !e.altKey) return null
  const code = e.code
  if (!code || /^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(code)) return null
  const parts: string[] = []
  if (ctrl) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(code)
  return parts.join('+')
}

/** 这个组合当下绑给了哪条应用快捷键 */
export function findShortcut(bindings: Record<ShortcutId, string>, combo: string | null): ShortcutId | null {
  if (!combo) return null
  for (const s of SHORTCUTS) if (bindings[s.id] === combo) return s.id
  return null
}

/**
 * 能不能把这个组合绑给 id。不能的话返回一句给用户看的原因。
 * 单独一个 Shift 不算修饰键：Shift+A 就是大写 A，绑了就没法打字了。
 */
export function bindingProblem(
  bindings: Record<ShortcutId, string>,
  id: ShortcutId,
  combo: string
): string | null {
  if (!/^(Ctrl\+|Alt\+)/.test(combo)) return '要带上 Ctrl 或 Alt，否则会和正常打字冲突'
  if (combo === 'Ctrl+Escape' || combo === 'Alt+Escape') return '这个组合留给系统了'
  if (HOST_RESERVED.has(combo)) {
    return isDesktop ? '这个组合被窗口菜单占着（刷新、缩放这类）' : '浏览器自己占了这个组合，网页里收不到'
  }
  const taken = findShortcut(bindings, combo)
  if (taken && taken !== id) {
    const label = SHORTCUTS.find((s) => s.id === taken)?.label
    return `已经被「${label}」占用了`
  }
  if (EDITOR_RESERVED.has(combo)) return '编辑器里已经用它做格式了，换一个'
  return null
}

/* code → 显示名。没列到的（比如 F 键、方向键）原样显示，去掉 Key/Digit 前缀 */
const CODE_LABELS: Record<string, string> = {
  Slash: '/',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: '空格',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

/** 'Ctrl+Shift+Slash' → 'Ctrl+Shift+/'，给 tooltip 和设置页用 */
export function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => CODE_LABELS[p] ?? p.replace(/^Key|^Digit|^Numpad/, ''))
    .join('+')
}
