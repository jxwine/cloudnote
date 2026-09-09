import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { TEXT_COLORS, HIGHLIGHTS } from '@/lib/palette'
import { ColorSpectrum } from './ColorSpectrum'
import { IconTextColor, IconHighlight } from './Icons'

/** 浮层宽度，用来把它约束在视口里。自定义面板比色板宽不少 */
const WIDTH = { swatches: 148, custom: 236 }

interface Props {
  editor: Editor
  kind: 'text' | 'highlight'
  /** 主工具栏用 icon-btn 的外观，浮动条用自己的一套，尺寸不同 */
  variant?: 'bar' | 'bubble'
}

/** 颜色按钮：点开是一格格色板，选「默认」即清掉颜色 */
export function ColorPicker({ editor, kind, variant = 'bar' }: Props) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const wrap = useRef<HTMLSpanElement>(null)
  const swatches = kind === 'text' ? TEXT_COLORS : HIGHLIGHTS

  const current =
    kind === 'text'
      ? (editor.getAttributes('textStyle').color as string | undefined)
      : (editor.getAttributes('highlight').color as string | undefined)

  // 主工具栏是横向滚动容器，absolute 浮层会被裁掉，所以那边用 fixed 并算坐标；
  // 浮动条由 floating-ui 用 transform 定位，fixed 会相对它而不是视口，只能用 absolute
  const anchored = variant === 'bubble'

  useLayoutEffect(() => {
    if (anchored || !open || !wrap.current) return
    const r = wrap.current.getBoundingClientRect()
    const w = custom ? WIDTH.custom : WIDTH.swatches
    setPos({
      left: Math.max(8, Math.min(r.left - 4, window.innerWidth - w - 8)),
      top: r.bottom + 6,
    })
  }, [open, anchored, custom])

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) {
        setOpen(false)
        setCustom(false)
      }
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])

  const apply = (color: string | null, keepOpen = false) => {
    const chain = editor.chain().focus()
    if (kind === 'text') color ? chain.setColor(color).run() : chain.unsetColor().run()
    else color ? chain.setHighlight({ color }).run() : chain.unsetHighlight().run()
    if (!keepOpen) {
      setOpen(false)
      setCustom(false)
    }
  }

  const title = kind === 'text' ? '文字颜色' : '背景高亮'

  return (
    <span className="color-picker" ref={wrap}>
      <button
        className={
          (variant === 'bar' ? 'icon-btn' : 'bubble-btn') + ' has-color-bar' + (current ? ' is-on' : '')
        }
        title={title}
        aria-label={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen((v) => !v)
          setCustom(false)
        }}
      >
        {kind === 'text' ? <IconTextColor /> : <IconHighlight />}
        <span
          className="color-bar"
          style={{ background: current || (kind === 'text' ? 'currentColor' : 'var(--text-3)') }}
        />
      </button>

      {open && (
        <div
          className={'swatches' + (anchored ? ' is-anchored' : '') + (custom ? ' is-custom' : '')}
          style={anchored ? undefined : pos}
          // 别让浮层抢走焦点，否则编辑器里的选区会丢，颜色就落不到选中的文字上
          onMouseDown={(e) => e.preventDefault()}
        >
          {custom ? (
            <>
              <ColorSpectrum value={current} onCommit={(c) => apply(c, true)} />
              <div className="swatches-foot">
                <button className="btn-ghost" onClick={() => setCustom(false)}>
                  返回色板
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setOpen(false)
                    setCustom(false)
                  }}
                >
                  完成
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="swatch-grid">
                <button className="swatch swatch-none" title="默认" onClick={() => apply(null)}>
                  ⌀
                </button>
                {swatches.map((c) => (
                  <button
                    key={c.value}
                    className={'swatch' + (current === c.value ? ' is-on' : '')}
                    style={{ background: c.value }}
                    title={c.label}
                    onClick={() => apply(c.value)}
                  />
                ))}
              </div>
              <button className="swatch-more" onClick={() => setCustom(true)}>
                <span className="swatch-more-chip" />
                自定义颜色…
              </button>
            </>
          )}
        </div>
      )}
    </span>
  )
}
