import { useEffect } from 'react'
import { useStore } from '@/lib/store'

/** 底部提示条。带撤销动作时停留久一点，给人反应时间。 */
export function Toast() {
  const toast = useStore((s) => s.toast)
  const hideToast = useStore((s) => s.hideToast)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(hideToast, toast.actionLabel ? 6000 : 3000)
    return () => clearTimeout(timer)
  }, [toast, hideToast])

  if (!toast) return null

  return (
    <div className="toast" role="status" key={toast.id}>
      <span className="toast-text">{toast.message}</span>
      {toast.actionLabel && (
        <button
          className="toast-action"
          onClick={() => {
            toast.onAction?.()
            hideToast()
          }}
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  )
}
