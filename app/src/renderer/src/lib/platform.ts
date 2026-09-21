/**
 * 运行环境判断。
 *
 * 网页版和桌面端是同一份构建产物，区别只有 preload 注入的 window.cloudnote 在不在。
 * 之前这个判断散在 App.tsx 和 export.ts 里好几处，收拢到这里，
 * 新增的「下载客户端」「检查更新」这类分支才不会各写各的。
 */
export const isDesktop = !!window.cloudnote

/** 桌面端专用 API。调用前先判 isDesktop，网页版拿到的是 undefined */
export const desktop = window.cloudnote

/**
 * 跑在 Capacitor 安卓壳里。除了这个判断，安卓端和网页版手机档是同一份代码——
 * 只在「浏览器能做、WebView 做不了」的地方（比如 blob 下载）分一下。
 */
export const isNative = !isDesktop && !!window.Capacitor?.isNativePlatform?.()

/** iPhone / iPad 的浏览器里（iPadOS 13 起 Safari 伪装成 Mac，靠触控点数认） */
export const isIOS =
  !isDesktop &&
  !isNative &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/** 已经是从主屏幕图标全屏打开的（PWA 或描述文件装的 Web Clip），不用再引导安装 */
export const isStandalone =
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
