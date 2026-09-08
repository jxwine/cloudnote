import { useRef } from 'react'

/**
 * 中文输入法的合成期保护。
 *
 * 用拼音打「测试」时，浏览器会在敲下每个字母时就抛 input 事件，
 * 那时输入框里是 "c"、"ce"、"ces"…… 直到选词才变成「测试」。
 * 谁在 onChange 里直接落库，谁就会把半截拼音存进去。
 *
 * 用法：显示照旧实时更新（不然打字会卡顿），只把「提交」这一步
 * 用 commit 包起来，合成结束时再补一次。
 *
 *   const ime = useImeGuard(save)
 *   <input
 *     onChange={(e) => { setDraft(e.target.value); ime.commit(e.target.value) }}
 *     {...ime.bind}
 *   />
 */
export function useImeGuard(onCommit: (value: string) => void) {
  const composing = useRef(false)

  return {
    /** 合成中就先不提交，等 compositionend */
    commit(value: string) {
      if (!composing.current) onCommit(value)
    },
    isComposing: () => composing.current,
    bind: {
      onCompositionStart: () => {
        composing.current = true
      },
      onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        composing.current = false
        // 选完词了，这才是用户真正想要的内容
        onCommit(e.currentTarget.value)
      },
    },
  }
}
