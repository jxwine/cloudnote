export function RenameInput({ initial, onCommit }: { initial: string; onCommit: (v: string) => void }) {
  return (
    <input
      className="tree-rename"
      aria-label="新名称"
      defaultValue={initial}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') onCommit('')
      }}
    />
  )
}
