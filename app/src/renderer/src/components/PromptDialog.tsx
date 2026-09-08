import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/lib/store'

/**
 * 取一行输入的对话框。Electron 禁用了 window.prompt，链接、图片地址这类输入
 * 都走这里，顺带比原生 prompt 更好看、能放第三个按钮（如「移除链接」）。
 */
export function PromptDialog() {
  const dialog = useStore((s) => s.dialog)
  const closeDialog = useStore((s) => s.closeDialog)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!dialog) return
    setValue(dialog.initial)
    // 等浮层挂上再选中，否则 select 会落空
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [dialog])

  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeDialog(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dialog, closeDialog])

  if (!dialog) return null

  return (
    <div className="overlay" onMouseDown={() => closeDialog(null)}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          closeDialog(value.trim())
        }}
      >
        <label className="dialog-title" htmlFor="prompt-input">
          {dialog.title}
        </label>
        <input
          id="prompt-input"
          ref={inputRef}
          value={value}
          placeholder={dialog.placeholder}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="dialog-actions">
          {dialog.extraLabel && (
            <button type="button" className="btn-ghost is-danger" onClick={() => closeDialog('')}>
              {dialog.extraLabel}
            </button>
          )}
          <span className="dialog-spacer" />
          <button type="button" className="btn-ghost" onClick={() => closeDialog(null)}>
            取消
          </button>
          <button type="submit" className="btn-primary">
            {dialog.confirmLabel ?? '确定'}
          </button>
        </div>
      </form>
    </div>
  )
}
