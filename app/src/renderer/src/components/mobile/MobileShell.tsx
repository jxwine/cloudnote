import { useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import { useSyncLifecycle } from '@/lib/useSyncLifecycle'
import { Toast } from '../Toast'
import { PromptDialog } from '../PromptDialog'
import { AuthExpiredDialog } from '../AuthExpiredDialog'
import { SettingsDialog } from '../SettingsDialog'
import { UpdateDialog } from '../UpdateDialog'
import { useUpdateCheck } from '@/lib/useUpdateCheck'
import { MobileHome } from './MobileHome'
import { MobileNote } from './MobileNote'

/** 编辑页的 hash。用 hash 而不是自己的 state：安卓的返回手势就是 history.back()，天然能退回首页 */
export const NOTE_ROUTE = '#/note'

/** 进编辑页。把 hash 推进历史，返回键才有地方可退 */
export const openNotePage = () => {
  if (location.hash === NOTE_ROUTE) return
  // pushState 不会触发 hashchange，App 的路由靠它，手动补一个
  history.pushState({ fromHome: true }, '', NOTE_ROUTE)
  dispatchEvent(new HashChangeEvent('hashchange'))
}

/** 回首页。是从首页推进来的就退一步，直接带着 #/note 打开的就直接改 hash */
export const closeNotePage = () => {
  if (history.state?.fromHome) history.back()
  else location.replace('#')
}

/**
 * 手机外壳：首页（卡片）和编辑页（全屏）两个页面，加上全局弹层。
 * 只在网页版 viewport === 'phone' 时挂载；桌面端永远走 Workspace。
 */
export function MobileShell({ route }: { route: string }) {
  useSyncLifecycle()
  const activeNoteId = useStore((s) => s.activeNoteId)
  const searchJump = useStore((s) => s.searchJump)
  const [settings, setSettings] = useState(false)
  // 安卓壳里查更新（网页手机档里这个 hook 什么都不做）
  const { update, setUpdate, available, manualCheck } = useUpdateCheck()
  /** 首页正在看的目录。放在这一层：进了编辑页首页会卸载，回来还得在那个目录里 */
  const [folderId, setFolderId] = useState<string | null>(null)

  const onNote = route === NOTE_ROUTE && !!activeNoteId

  /* 点了搜索结果：jumpToSearchHit 只改 store，这里负责把页面切过去 */
  useEffect(() => {
    if (searchJump) openNotePage()
  }, [searchJump])

  /* 带着 #/note 但没有选中的笔记（比如删掉了当前笔记）：退回首页，别停在空页上 */
  useEffect(() => {
    if (route === NOTE_ROUTE && !activeNoteId) location.replace('#')
  }, [route, activeNoteId])

  return (
    <div className="m-app">
      {onNote ? (
        <MobileNote />
      ) : (
        <MobileHome folderId={folderId} setFolderId={setFolderId} onOpenSettings={() => setSettings(true)} />
      )}

      <Toast />
      <PromptDialog />
      {settings && (
        <SettingsDialog
          onClose={() => setSettings(false)}
          onCheckUpdate={() => void manualCheck()}
          newVersion={available?.version ?? null}
        />
      )}
      {update && <UpdateDialog info={update} onClose={() => setUpdate(null)} />}
      <AuthExpiredDialog />
    </div>
  )
}
