import { create } from 'zustand'
import type { ExportFormat } from './exportFormats'

type Request = { title: string; bulk: boolean; resolve: (format: ExportFormat | null) => void }
export const useExportDialog = create<{ request: Request | null }>(() => ({ request: null }))

export function chooseExportFormat(title: string, bulk: boolean): Promise<ExportFormat | null> {
  closeExportDialog(null)
  return new Promise((resolve) => useExportDialog.setState({ request: { title, bulk, resolve } }))
}

export function closeExportDialog(format: ExportFormat | null) {
  const request = useExportDialog.getState().request
  useExportDialog.setState({ request: null })
  request?.resolve(format)
}
