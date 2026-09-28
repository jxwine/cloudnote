import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/lib/store'
import * as sync from '@/lib/sync'
import { folderPath, formatDate } from '@/lib/search'
import { blockedLock, canReadNote, prepareToLock, retainedGrants } from '@/lib/readingLock'
import type { LockTarget } from '@/lib/types'
import { ReadingLockPane } from './ReadingLock'
import { IconChevron, IconClose, IconFolder, IconLock, IconNote, IconRestore, IconTrash } from './Icons'

/** 回收站：删掉的笔记在这里等着，可以放回去，也可以彻底清掉 */
export function Trash() {
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const lockGrants = useStore((s) => s.lockGrants)
  const [purging, setPurging] = useState<string | null>(null)
  const [unlockTarget, setUnlockTarget] = useState<LockTarget | null>(null)

  const items = useMemo(
    () =>
      Object.values(notes)
        .filter((n) => n.deleted)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [notes]
  )

  useEffect(() => {
    if (unlockTarget && (!notes[unlockTarget.id]?.deleted || !blockedLock({ notes, folders, lockGrants }, unlockTarget))) {
      setUnlockTarget(null)
    }
  }, [unlockTarget, notes, folders, lockGrants])

  const startUnlock = (id: string) => {
    const target: LockTarget = { kind: 'note', id }
    prepareToLock()
    const state = useStore.getState()
    useStore.setState({ lockScope: target, lockGrants: retainedGrants(state, target), lockEpoch: state.lockEpoch + 1 })
    setPurging(null)
    setUnlockTarget(target)
  }

  if (!items.length) {
    return (
      <div className="tree-empty">
        回收站是空的。
        <br />
        删掉的笔记会先放到这里。
      </div>
    )
  }

  return (
    <>
      <div className="search-count">
        {items.length} 篇已删除
        <button
          className="trash-purge-all"
          onClick={() => {
            const state = useStore.getState()
            if (items.some((note) => !canReadNote(state, note))) {
              state.showToast({ message: '回收站包含锁定笔记，请解锁后逐项删除' })
              setPurging(null)
              return
            }
            if (purging === '__all__') {
              items.forEach((n) => void sync.purgeNote(n.id))
              setPurging(null)
            } else {
              setPurging('__all__')
            }
          }}
        >
          {purging === '__all__' ? '确认清空？' : '清空'}
        </button>
      </div>

      <div className="hit-list">
        {items.map((note) => {
          if (!canReadNote({ notes, folders, lockGrants }, note)) {
            return <div key={note.id} className="hit is-trash">
              <span className="hit-title"><IconLock size={15} className="hit-title-icon" /><span className="hit-title-text">受密码保护的笔记</span></span>
              <span className="trash-actions"><button className="btn-ghost" onClick={() => startUnlock(note.id)}>解锁后管理</button></span>
            </div>
          }
          const path = folderPath(note.folderId, folders)
          return (
            <div key={note.id} className="hit is-trash">
              <span className="hit-title">
                <IconNote size={15} className="hit-title-icon" />
                <span className="hit-title-text">{note.title?.trim() || '无标题'}</span>
              </span>

              {note.excerpt && <span className="hit-snippet">{note.excerpt}</span>}

              <span className="hit-meta">
                <span className="hit-path">
                  <IconFolder size={13} />
                  <span>全部笔记</span>
                  {path.map((name) => (
                    <span key={name} className="hit-path-part">
                      <IconChevron size={11} />
                      <span>{name}</span>
                    </span>
                  ))}
                </span>
                <span className="hit-date">{formatDate(note.updatedAt)}</span>
              </span>

              <span className="trash-actions">
                <button className="btn-ghost" onClick={() => void sync.restoreNote(note.id)}>
                  <IconRestore size={14} />
                  放回去
                </button>
                <button
                  className={'btn-ghost is-danger' + (purging === note.id ? ' is-armed' : '')}
                  onClick={() => {
                    if (purging === note.id) {
                      void sync.purgeNote(note.id)
                      setPurging(null)
                    } else {
                      setPurging(note.id)
                    }
                  }}
                  onBlur={() => setPurging((p) => (p === note.id ? null : p))}
                >
                  <IconTrash size={14} />
                  {purging === note.id ? '确认删除？' : '彻底删除'}
                </button>
              </span>
            </div>
          )
        })}
      </div>
      {unlockTarget && blockedLock({ notes, folders, lockGrants }, unlockTarget) &&
        <TrashUnlockDialog target={unlockTarget} onClose={() => setUnlockTarget(null)} />}
    </>
  )
}

function TrashUnlockDialog({ target, onClose }: { target: LockTarget; onClose: () => void }) {
  const cancel = () => {
    const state = useStore.getState()
    if (blockedLock(state, target)) state.relock()
    onClose()
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 账号验证弹层自行处理 Escape，不能同时关闭底下的阅读解锁层。
      if (event.key === 'Escape' && !useStore.getState().readingLockDialog) {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [target, onClose])
  return <div className="overlay" onMouseDown={cancel}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label="解锁回收站笔记" onMouseDown={(event) => event.stopPropagation()}>
      <div className="dialog-actions"><span className="dialog-spacer" /><button className="icon-btn" title="关闭" aria-label="关闭解锁" onClick={cancel}><IconClose size={16} /></button></div>
      <ReadingLockPane target={target} />
    </div>
  </div>
}
