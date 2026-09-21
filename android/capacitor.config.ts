import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 安卓端就是网页版手机档装进 WebView 壳。
 * www/ 由 scripts/build-www.mjs 从 app/out/renderer 拷来（顺手改一处 CSP），不要手改。
 */
const config: CapacitorConfig = {
  appId: 'com.cloudnote.app',
  appName: '云笔记',
  webDir: 'www',
  android: {
    // 键盘弹出时收缩 WebView（等价于 Android 的 adjustResize），编辑器工具栏才能贴在键盘上方
    adjustMarginsForEdgeToEdge: 'auto',
    // 页面源是 https://localhost，连 http:// 的自建服务算「混合内容」，不放开会被 WebView 拦掉。
    // 配合 AndroidManifest 里的 usesCleartextTraffic。服务器地址是用户自己填的，风险可控
    allowMixedContent: true,
  },
  server: {
    // 页面跑在 https://localhost 这个虚拟源上；localStorage 里的账号缓存都挂在它下面，以后别改
    androidScheme: 'https',
  },
}

export default config
