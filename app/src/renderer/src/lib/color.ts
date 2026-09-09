/**
 * 取色板要用的颜色换算。
 *
 * 只覆盖这个场景需要的几种写法：#rgb / #rrggbb / #rrggbbaa / rgb() / rgba()。
 * 不引色彩库——这里一共几十行，而多一个依赖就多一份要跟着升级的东西。
 */

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0~1 */
  a: number
}

export interface Hsva {
  /** 0~360 */
  h: number
  /** 0~1 */
  s: number
  /** 0~1 */
  v: number
  a: number
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))
const byte = (n: number) => clamp(Math.round(n), 0, 255)
const hex2 = (n: number) => byte(n).toString(16).padStart(2, '0')

/** 解析成 RGBA；认不出来就返回 null，交给调用方决定用什么兜底 */
export function parseColor(input: string): Rgba | null {
  const s = String(input || '').trim().toLowerCase()
  if (!s) return null

  const m = /^#([0-9a-f]{3,8})$/.exec(s)
  if (m) {
    const h = m[1]
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16))
      return { r, g, b, a: h.length === 4 ? a / 255 : 1 }
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
    }
    return null
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(s)
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean)
    if (parts.length < 3) return null
    const num = (t: string) => (t.endsWith('%') ? (parseFloat(t) / 100) * 255 : parseFloat(t))
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
    return { r: byte(num(parts[0])), g: byte(num(parts[1])), b: byte(num(parts[2])), a: clamp(a) }
  }
  return null
}

/** 不透明时输出 6 位，带透明度时输出 8 位——短的那种更常见，也更好认 */
export function toHex({ r, g, b, a }: Rgba): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return a >= 1 ? base : base + hex2(a * 255)
}

export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const d = max - min

  let h = 0
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a }
}

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const i = Math.floor(h / 60) % 6
  const table: [number, number, number][] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ]
  const [r, g, b] = table[i < 0 ? i + 6 : i]
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255), a }
}

/** 纯色相，用来画 SV 色域的底 */
export const hueColor = (h: number) => toHex(hsvToRgb({ h, s: 1, v: 1, a: 1 }))

/**
 * 这个颜色上面放白字还是黑字？
 * 用感知亮度而不是简单平均——同样的数值，绿看着比蓝亮得多。
 */
export function isLight({ r, g, b }: Rgba): boolean {
  return (r * 299 + g * 587 + b * 114) / 1000 > 150
}
