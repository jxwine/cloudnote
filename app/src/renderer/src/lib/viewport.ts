/**
 * 网页版的屏幕档位。
 *
 * 桌面端（Electron）永远是 desktop：窗口再窄也保持三栏，这是刻意的——
 * 响应式只为浏览器里的手机 / 平板服务，桌面端一个像素都不动。
 *
 * 档位：
 *   phone   ≤ 720px  单栏，两侧栏都是覆盖式抽屉
 *   tablet  ≤ 1024px 目录树留在原位，大纲改成覆盖式抽屉
 *   desktop 其它     现状三栏
 *
 * App 顶层把档位挂到 <html data-viewport>，样式全部用它做前缀（见 app.css 末尾），
 * 不写裸 @media——这样 Electron 里那些规则一条都匹配不上。
 */
import { isDesktop } from './platform'

export type Viewport = 'phone' | 'tablet' | 'desktop'

export const PHONE_MAX = 720
export const TABLET_MAX = 1024

const canQuery = () => !isDesktop && typeof matchMedia === 'function'

export function readViewport(): Viewport {
  if (!canQuery()) return 'desktop'
  if (matchMedia(`(max-width: ${PHONE_MAX}px)`).matches) return 'phone'
  if (matchMedia(`(max-width: ${TABLET_MAX}px)`).matches) return 'tablet'
  return 'desktop'
}

/** 监听档位变化（旋转、拖窗口）。挂上时立刻回调一次；返回解绑函数 */
export function watchViewport(cb: (v: Viewport) => void): () => void {
  cb(readViewport())
  if (!canQuery()) return () => {}
  const queries = [
    matchMedia(`(max-width: ${PHONE_MAX}px)`),
    matchMedia(`(max-width: ${TABLET_MAX}px)`),
  ]
  const onChange = () => cb(readViewport())
  queries.forEach((q) => q.addEventListener('change', onChange))
  return () => queries.forEach((q) => q.removeEventListener('change', onChange))
}

/**
 * 主要输入方式是触屏（没有 hover、指针粗）。
 * 和宽度是两回事：带鼠标的窄窗口 hover 照样好使，触屏平板再宽也没有 hover。
 * 靠它决定：目录树行的操作按钮常显、关掉 HTML5 拖拽、链接点击不直接跳走。
 */
export const isTouch =
  !isDesktop && typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches
