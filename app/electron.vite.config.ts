import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 两个入口：loader 是 package.json 的 main，只负责挑热更新包再 require 真正的 index
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          loader: resolve(__dirname, 'src/main/loader.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
    define: {
      // 打包时指定了远程服务器（VITE_CLOUDNOTE_SERVER）就别再起本地那份后端，
      // 白占端口和内存。没指定时保留，装上就能单机用。
      __USE_BUNDLED_SERVER__: JSON.stringify(!process.env.VITE_CLOUDNOTE_SERVER),
    },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()],
  },
})
