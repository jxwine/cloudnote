import { useEffect, useRef, useState } from 'react'
import { closeExportDialog, useExportDialog } from '@/lib/exportDialog'
import { EXPORT_FORMATS, type ExportFormat } from '@/lib/exportFormats'
import { isDesktop, desktop } from '@/lib/platform'
import { useStore } from '@/lib/store'

export function ExportDialog() {
  const request = useExportDialog((s) => s.request)
  const user = useStore((s) => s.user)
  const [format, setFormat] = useState<ExportFormat>('md')
  const form = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!request) return
    setFormat('md')
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('input:checked')?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeExportDialog(null)
      }
      if (e.key === 'Tab') {
        const inputs = Array.from(form.current?.querySelectorAll<HTMLElement>('input:checked, button') || [])
        const first = inputs[0], last = inputs[inputs.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [request])

  useEffect(() => { closeExportDialog(null) }, [user?.id])

  if (!request) return null
  return (
    <div className="overlay" onMouseDown={() => closeExportDialog(null)}>
      <form ref={form} className="dialog export-dialog" role="dialog" aria-modal="true"
        aria-labelledby="export-title" aria-describedby="export-hint"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); closeExportDialog(format) }}>
        <h2 id="export-title" className="dialog-title">{request.title}</h2>
        <fieldset className="export-formats">
          <legend>选择导出格式</legend>
          {EXPORT_FORMATS.map((option) => (
            <label key={option.id} className={`export-option${format === option.id ? ' is-selected' : ''}`}>
              <input type="radio" name="export-format" value={option.id} checked={format === option.id}
                onChange={() => setFormat(option.id)} />
              <span><strong>{option.label} <small>{option.extension}</small></strong><span>{option.description}</span></span>
            </label>
          ))}
        </fieldset>
        <p id="export-hint" className="export-hint">
          {request.bulk ? (isDesktop && (format === 'md' || desktop?.exportBinary) ? '按原目录结构保存，每篇笔记一个文件。' : '所选范围合并为一个文件，包含目录路径。')
            : '导出当前笔记，包含最新编辑内容。'}
          {format === 'docx' && ' 适用于 Word 2007 及以上版本、Microsoft 365 和 WPS。'}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={() => closeExportDialog(null)}>取消</button>
          <button type="submit" className="btn-primary">导出</button>
        </div>
      </form>
    </div>
  )
}
