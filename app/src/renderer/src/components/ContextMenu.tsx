import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuAction {
  label: string
  icon?: React.ReactNode
  shortcut?: string
  danger?: boolean
  /** 灰掉且点不动。用在「不能停用自己」这种当前上下文下不成立的动作上 */
  disabled?: boolean
  onSelect: () => void
}

interface Props {
  x: number
  y: number
  actions: (MenuAction | 'separator')[]
  /** 把菜单唤出来的那个按钮；点它不在这里关，交给按钮自己做开关 */
  anchor?: HTMLElement | null
  onClose: () => void
}

/** 浮层菜单：点击外部、按 Esc 或滚动都会关闭，并自动避开窗口边缘 */
export function ContextMenu({ x, y, actions, anchor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, window.innerWidth - width - 8),
      top: Math.min(y, window.innerHeight - height - 8),
    })
  }, [x, y])

  useEffect(() => {
    // 捕获阶段监听，保证点其它交互元素前先收起菜单；但点在菜单自己身上时必须放行，
    // 否则菜单会在 click 到达菜单项之前就被卸载，点什么都没反应
    const close = (e: Event) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      // 点的正是唤出它的那个按钮：这里放行，让按钮的 onClick 去收起菜单。
      // 否则会在 pointerdown 时关掉、紧接着 click 又把它打开，看着像关不掉。
      if (anchor?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchor])

  return (
    <div ref={ref} className="menu" style={pos} role="menu" onPointerDown={(e) => e.stopPropagation()}>
      {actions.map((action, i) =>
        action === 'separator' ? (
          <div key={`sep-${i}`} className="menu-sep" />
        ) : (
          <button
            key={action.label}
            role="menuitem"
            className={'menu-item' + (action.danger ? ' is-danger' : '')}
            disabled={action.disabled}
            // 不让按钮抢走焦点，否则编辑器里的选区会丢，格式命令就作用不到选中的文字上
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              action.onSelect()
              onClose()
            }}
          >
            {action.icon}
            <span>{action.label}</span>
            {action.shortcut && <kbd>{action.shortcut}</kbd>}
          </button>
        )
      )}
    </div>
  )
}

interface MenuState {
  x: number
  y: number
  actions: (MenuAction | 'separator')[]
  anchor: HTMLElement | null
}

/** 管理「在哪儿弹菜单、弹什么」的小 hook */
export function useContextMenu() {
  const [state, setState] = useState<MenuState | null>(null)

  const open = (e: React.MouseEvent, actions: (MenuAction | 'separator')[]) => {
    e.preventDefault()
    e.stopPropagation()
    setState({ x: e.clientX, y: e.clientY, actions, anchor: null })
  }

  const openAt = (el: HTMLElement, actions: (MenuAction | 'separator')[]) => {
    // 同一个按钮再点一次就收起来，符合「点开、点关」的直觉
    if (state?.anchor === el) {
      setState(null)
      return
    }
    const r = el.getBoundingClientRect()
    setState({ x: r.left, y: r.bottom + 4, actions, anchor: el })
  }

  const node = state ? <ContextMenu {...state} onClose={() => setState(null)} /> : null
  return { open, openAt, node }
}
