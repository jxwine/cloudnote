import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
