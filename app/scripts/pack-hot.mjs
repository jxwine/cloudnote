/**
 * 打热更新包：out/ + build/ + package.json 打成一个 asar，放到 release/。
 *
 * 不直接拿 electron-builder 产出的 resources/app.asar 复制一份，两个原因：
 * 一是那份里带 node_modules（主进程其实只用内置模块），二是 package.json 里要注入
 * 这份代码是对着哪个 Electron 构建的，loader 靠它拒绝错配的包——而 asar 打好之后
 * 改里面的文件比重新打一次麻烦。
 *
 * 用法：npm run dist（整包 + 热更新包）或 npm run dist:hot（只要热更新包）。
 */
import { createPackage } from '@electron/asar'
import { readFileSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 热更新包里的渲染层也带着默认服务器地址，和整包一样必须注入，否则用户更新完会连到 localhost
if (!process.env.VITE_CLOUDNOTE_SERVER) {
  console.warn('警告：没有设置 VITE_CLOUDNOTE_SERVER，这个热更新包默认连 localhost:4471，只适合自建服务的场景')
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version

// 复制用异步版：同一个进程里 cpSync 完紧接着 createPackage，Node 24 会直接崩（0xC0000409，没有任何输出）
const staging = join(root, 'release', '.hot-staging')
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
await cp(join(root, 'out'), join(staging, 'out'), { recursive: true })
await cp(join(root, 'build'), join(staging, 'build'), { recursive: true })

// 只留运行时需要的字段；main 指向真正的入口而不是 loader——loader 永远跑安装包里那份
await writeFile(
  join(staging, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      main: './out/main/index.js',
      cloudnote: { electron: electronVersion },
    },
    null,
    2
  )
)

const out = join(root, 'release', `云笔记 热更新 ${pkg.version}.asar`)
await rm(out, { force: true })
await createPackage(staging, out)
await rm(staging, { recursive: true, force: true })
console.log(`热更新包：${out}（要求 Electron ${electronVersion.split('.')[0]}）`)
