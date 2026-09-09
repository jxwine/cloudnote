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
