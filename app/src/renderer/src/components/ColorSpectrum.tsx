import { useEffect, useRef, useState } from 'react'
import { hsvToRgb, hueColor, parseColor, rgbToHsv, toHex, type Hsva } from '@/lib/color'

interface Props {
  /** 当前颜色，认不出来就从红色起步 */
  value?: string
  /** 松手或输入框回车时回调，一次手势只落一次，免得撑爆撤销栈 */
  onCommit: (color: string) => void
}

const FALLBACK: Hsva = { h: 0, s: 1, v: 1, a: 1 }

const pin = (n: number) => Math.min(1, Math.max(0, n))

/**
 * 在一块区域里按下并拖动，把指针位置换算成 0~1 的两个分量。
 *
 * 监听挂在 window 上而不是元素上：手指/鼠标拖出色域边界是常态，
 * 挂在元素上一出界就断了，得一路跟到松手为止。
 */
function useDragArea(onMove: (x: number, y: number) => void, onEnd: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const moveRef = useRef(onMove)
  const endRef = useRef(onEnd)
  moveRef.current = onMove
  endRef.current = onEnd

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const el = ref.current
    if (!el) return
    const read = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      moveRef.current(pin((ev.clientX - r.left) / r.width), pin((ev.clientY - r.top) / r.height))
    }
    read(e)
    const move = (ev: PointerEvent) => read(ev)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endRef.current()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return { ref, onPointerDown }
}

/**
 * 自定义取色板：上面是饱和度/明度色域，下面是色相条和透明度条，再下面是数值输入。
 *
 * 色域不用 canvas——两层 CSS 渐变叠出来的效果一样，还能跟着容器尺寸自适应，
 * 不必操心 devicePixelRatio 和重绘。
 */
export function ColorSpectrum({ value, onCommit }: Props) {
  const [hsv, setHsv] = useState<Hsva>(() => {
    const rgb = parseColor(value || '')
    return rgb ? rgbToHsv(rgb) : FALLBACK
  })
  /** 输入框里正在打的字。打一半的 "#ff" 不该被当成颜色，所以单独存 */
  const [hexDraft, setHexDraft] = useState<string | null>(null)

  const rgb = hsvToRgb(hsv)
  const hex = toHex(rgb)

  // 外面换了颜色（比如点了预设色块）就跟过去，但正在打字时别打断
  useEffect(() => {
    if (hexDraft !== null) return
    const next = parseColor(value || '')
    if (next && toHex(next) !== hex) setHsv(rgbToHsv(next))
    // hex/hexDraft 是本地推导值，跟着 value 走就够了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // 一次拖拽只在松手时提交一次，中途不提交——否则每动一像素就是一条撤销记录
  const commit = () => onCommit(toHex(hsvToRgb(hsv)))

  const sv = useDragArea((x, y) => setHsv((c) => ({ ...c, s: x, v: 1 - y })), commit)
  const hue = useDragArea((x) => setHsv((c) => ({ ...c, h: x * 360 })), commit)
  const alpha = useDragArea((x) => setHsv((c) => ({ ...c, a: x })), commit)

  const setChannel = (key: 'r' | 'g' | 'b', raw: string) => {
    const n = Math.min(255, Math.max(0, Number(raw) || 0))
    const next = rgbToHsv({ ...rgb, [key]: n })
    setHsv(next)
    onCommit(toHex(hsvToRgb(next)))
  }

  const commitHex = () => {
    if (hexDraft === null) return
    const parsed = parseColor(hexDraft.startsWith('#') ? hexDraft : '#' + hexDraft)
    setHexDraft(null)
    if (parsed) {
      setHsv(rgbToHsv(parsed))
      onCommit(toHex(parsed))
    }
  }

  const opaque = toHex({ ...rgb, a: 1 })

  return (
    <div className="spectrum">
      <div
        className="spectrum-sv"
        ref={sv.ref}
        onPointerDown={sv.onPointerDown}
        style={{ backgroundColor: hueColor(hsv.h) }}
      >
        <span
          className="spectrum-dot"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }}
        />
      </div>

      <div className="spectrum-sliders">
        <div className="spectrum-tracks">
          <div className="spectrum-hue" ref={hue.ref} onPointerDown={hue.onPointerDown}>
            <span className="spectrum-knob" style={{ left: `${(hsv.h / 360) * 100}%` }} />
          </div>
          <div className="spectrum-alpha" ref={alpha.ref} onPointerDown={alpha.onPointerDown}>
            <span
              className="spectrum-alpha-fill"
              style={{ background: `linear-gradient(to right, transparent, ${opaque})` }}
            />
            <span className="spectrum-knob" style={{ left: `${hsv.a * 100}%` }} />
          </div>
        </div>
        <span className="spectrum-preview" style={{ background: hex }} />
      </div>

      <div className="spectrum-fields">
        <label>
          <input
            value={hexDraft ?? hex}
            spellCheck={false}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={commitHex}
            onKeyDown={(e) => e.key === 'Enter' && commitHex()}
          />
          <span>HEX</span>
        </label>
        {(['r', 'g', 'b'] as const).map((k) => (
          <label key={k} className="is-num">
            <input
              value={rgb[k]}
              inputMode="numeric"
              onChange={(e) => setChannel(k, e.target.value)}
            />
            <span>{k.toUpperCase()}</span>
          </label>
        ))}
        <label className="is-num">
          <input
            value={Math.round(hsv.a * 100)}
            inputMode="numeric"
            onChange={(e) => {
              const a = Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100
              setHsv((c) => ({ ...c, a }))
              onCommit(toHex(hsvToRgb({ ...hsv, a })))
            }}
          />
          <span>A</span>
        </label>
      </div>
    </div>
  )
}
