import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 读 server/.env 填进 process.env。
 *
 * 本模块靠「被 import 时的副作用」生效，必须放在 index.js 的第一行 import：
 * ESM 的 import 会提升，写成 `import {loadEnv}` 再调用是来不及的——
 * 那时 db.js 早就读完 process.env 了。
 *
 * 不引 dotenv：需要的只是「按行拆 KEY=VALUE」，二十行就够了，
 * 少一个依赖，部署时少一件要装的东西。
 * 已经存在的环境变量优先——命令行和面板里设的值不该被文件盖掉。
 */
export function loadEnv() {
  const here = dirname(fileURLToPath(import.meta.url))
  const file = resolve(here, '../.env')
  if (!existsSync(file)) return

  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at < 1) continue
    const key = line.slice(0, at).trim()
    if (key in process.env) continue // 外部已经给了就不覆盖
    let value = line.slice(at + 1).trim()
    // 去掉成对的引号，允许 KEY="含空格的值"
    if (value.length > 1 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

// 被 import 时立刻执行。index.js 第一行 `import './env.js'` 就是为了这个。
loadEnv()
