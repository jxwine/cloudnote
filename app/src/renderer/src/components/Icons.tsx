interface Props {
  size?: number
  className?: string
}

/** 统一 1.6 线宽、圆端点的线性图标，保证界面上所有符号视觉重量一致 */
const svg = (path: React.ReactNode, viewBox = '0 0 24 24') =>
  function Icon({ size = 16, className }: Props) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    )
  }

export const IconChevron = svg(<path d="M9 5l7 7-7 7" />)
export const IconFolder = svg(<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.4h7A1.5 1.5 0 0 1 19 9.9v7.6a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />)
export const IconNote = svg(
  <>
    <path d="M6 3.5h8.5L19 8v12.5H6z" />
    <path d="M14 3.5V8H19M9 12.5h7M9 16h5" />
  </>
)
export const IconPlus = svg(<path d="M12 5v14M5 12h14" />)
export const IconFolderPlus = svg(
  <>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.4h7A1.5 1.5 0 0 1 19 9.9v7.6a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
    <path d="M11 12.5h4M13 10.5v4" />
  </>
)
export const IconSearch = svg(
  <>
    <circle cx="11" cy="11" r="6.2" />
    <path d="M15.5 15.5L20 20" />
  </>
)
export const IconMore = svg(
  <>
    <circle cx="5.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </>
)
export const IconTrash = svg(
  <>
    <path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7" />
    <path d="M6.5 6.5l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12.1" />
  </>
)
export const IconPencil = svg(<path d="M4 20l.9-4.2L15.6 5.1a1.9 1.9 0 0 1 2.7 0l1.2 1.2a1.9 1.9 0 0 1 0 2.7L8.8 19.7z" />)
export const IconPanelLeft = svg(
  <>
    <rect x="3.2" y="4.5" width="17.6" height="15" rx="2" />
    <path d="M9.6 4.5v15" />
  </>
)
export const IconPanelRight = svg(
  <>
    <rect x="3.2" y="4.5" width="17.6" height="15" rx="2" />
    <path d="M14.4 4.5v15" />
  </>
)
export const IconBold = svg(<path d="M7.5 4.5h5.8a3.75 3.75 0 0 1 0 7.5H7.5zM7.5 12h6.6a3.75 3.75 0 0 1 0 7.5H7.5z" />)
export const IconItalic = svg(<path d="M15.5 4.5h-5M13.5 19.5h-5M14 4.5l-4 15" />)
export const IconStrike = svg(<path d="M5 12h14M8 8.2c0-2.2 1.7-3.7 4.2-3.7 2 0 3.5.9 4 2.4M16 15c0 2.5-1.7 4.5-4.4 4.5-2.5 0-4.3-1.2-4.6-3.3" />)
export const IconCode = svg(<path d="M9 7.5L4.5 12 9 16.5M15 7.5L19.5 12 15 16.5" />)
export const IconHighlight = svg(
  <>
    <path d="M4 20h6" />
    <path d="M8.5 16.5l-2.8.6.6-2.8L15.6 5.1a1.6 1.6 0 0 1 2.3 0l1 1a1.6 1.6 0 0 1 0 2.3z" />
  </>
)
export const IconLink = svg(
  <>
    <path d="M10.5 13.5a3.6 3.6 0 0 0 5.2 0l2.6-2.6a3.7 3.7 0 0 0-5.2-5.2l-1.4 1.4" />
    <path d="M13.5 10.5a3.6 3.6 0 0 0-5.2 0l-2.6 2.6a3.7 3.7 0 0 0 5.2 5.2l1.4-1.4" />
  </>
)
export const IconList = svg(<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />)
export const IconListOrdered = svg(
  <>
    <path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10" />
    <path d="M4 4.8l1.2-.6v3.3M3.7 11.3c.2-.5.7-.8 1.2-.8.7 0 1.2.5 1.2 1.1 0 1-2.4 1.5-2.4 2.9h2.6M3.8 16.6c.2-.4.7-.7 1.2-.7.7 0 1.2.5 1.2 1s-.5 1-1.2 1c.8 0 1.4.4 1.4 1.1s-.6 1.2-1.4 1.2c-.6 0-1.1-.3-1.3-.8" strokeWidth={1.3} />
  </>
)
export const IconTask = svg(
  <>
    <rect x="3.5" y="4.5" width="7" height="7" rx="1.6" />
    <path d="M5.2 8l1.5 1.5L9.2 6.5M14 8h6M14 16h6M3.5 16h6" />
  </>
)
export const IconQuote = svg(<path d="M9.5 6.5C7 7.6 5.5 9.8 5.5 12.4V17.5h5v-5h-3c0-2 .8-3.5 2.6-4.4zM19 6.5c-2.5 1.1-4 3.3-4 5.9V17.5h5v-5h-3c0-2 .8-3.5 2.6-4.4z" />)
export const IconCodeBlock = svg(
  <>
    <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2" />
    <path d="M9.5 9.8L7.2 12l2.3 2.2M14.5 9.8L16.8 12l-2.3 2.2" />
  </>
)
export const IconTable = svg(
  <>
    <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2" />
    <path d="M3.2 9.8h17.6M9.5 9.8v9.4" />
  </>
)
export const IconRule = svg(<path d="M4 12h16" />)
export const IconHeading = svg(<path d="M6 5v14M18 5v14M6 12h12" />)
export const IconUndo = svg(<path d="M9.5 8.5H15a4.5 4.5 0 0 1 0 9h-4M9.5 8.5L13 5M9.5 8.5L13 12" />)
export const IconRedo = svg(<path d="M14.5 8.5H9a4.5 4.5 0 0 0 0 9h4M14.5 8.5L11 5M14.5 8.5L11 12" />)
export const IconSun = svg(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
  </>
)
export const IconMoon = svg(<path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5z" />)
export const IconLogout = svg(<path d="M14.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h7a1.5 1.5 0 0 0 1.5-1.5v-2.5M10 12h9.5M17 9.2l2.8 2.8-2.8 2.8" />)
export const IconClose = svg(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />)
export const IconCloud = svg(<path d="M7.2 18.5A4.2 4.2 0 0 1 6.6 10a5.6 5.6 0 0 1 10.8-1.2 3.9 3.9 0 0 1-.6 9.7z" />)
export const IconServer = svg(
  <>
    <rect x="3.5" y="4.5" width="17" height="6" rx="1.6" />
    <rect x="3.5" y="13.5" width="17" height="6" rx="1.6" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </>
)

export const IconUnderline = svg(<path d="M6.5 4v6.5a5.5 5.5 0 0 0 11 0V4M5 20h14" />)
export const IconClearFormat = svg(
  <>
    <path d="M15.4 4.6l4 4a1.4 1.4 0 0 1 0 2L11 19H7.2l-2.6-2.6a1.4 1.4 0 0 1 0-2l8.8-8.8a1.4 1.4 0 0 1 2 0z" />
    <path d="M9.2 8.4l6.4 6.4M9 19.4h11" />
  </>
)
export const IconTextColor = svg(<path d="M5.5 16.5L11 5h2l5.5 11.5M8 12.5h8" />)
export const IconChevronDown = svg(<path d="M6 9.5l6 6 6-6" />)
export const IconImage = svg(
  <>
    <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2" />
    <circle cx="8.6" cy="10" r="1.5" />
    <path d="M3.6 16.5l4.6-4.2 3.4 3 3-2.6 5.8 5" />
  </>
)
export const IconUpload = svg(<path d="M12 16V4.5M8.2 8.3L12 4.5l3.8 3.8M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" />)
export const IconWide = svg(
  <>
    <path d="M3.5 6.5v11M20.5 6.5v11" />
    <path d="M7.5 12h9M9.5 9.5L7 12l2.5 2.5M14.5 9.5L17 12l-2.5 2.5" />
  </>
)

export const IconFolderOpen = svg(
  <>
    <path d="M3 8.2V6.4A1.4 1.4 0 0 1 4.4 5h4L10.4 7h6.2A1.4 1.4 0 0 1 18 8.4v1.4" />
    <path d="M3 8.2h16.1a1.4 1.4 0 0 1 1.36 1.75l-1.9 7.6A1.4 1.4 0 0 1 17.2 18.6H4.4A1.4 1.4 0 0 1 3 17.2z" />
  </>
)

export const IconTag = svg(
  <>
    <path d="M4 11.6V5.4A1.4 1.4 0 0 1 5.4 4h6.2a1.4 1.4 0 0 1 1 .4l7 7a1.4 1.4 0 0 1 0 2l-6.2 6.2a1.4 1.4 0 0 1-2 0l-7-7a1.4 1.4 0 0 1-.4-1z" />
    <path d="M8 8h.01" />
  </>
)
export const IconHistory = svg(
  <>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 5v4.2h4.2" />
    <path d="M12 7.8V12l3 1.8" />
  </>
)
export const IconExport = svg(<path d="M12 3.5v10M8.2 7.3L12 3.5l3.8 3.8M4.5 14v4.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V14" />)
export const IconRestore = svg(
  <>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 5v4.2h4.2" />
  </>
)
export const IconKey = svg(
  <>
    <circle cx="8" cy="14.5" r="3.5" />
    <path d="M10.6 12L19 3.6M16.4 6.2l2 2M14 8.6l2 2" />
  </>
)
export const IconJump = svg(
  <>
    <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2" />
    <path d="M8 10.5l2.5 2.5L8 15.5M13 15.5h3.5" />
  </>
)
