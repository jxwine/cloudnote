/** 把 gradle 出的 release 包按版本号改名拷到 app/release/，和 exe / asar 放一起 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(resolve(here, '../../app/package.json'), 'utf8')).version
const apk = resolve(here, '../android/app/build/outputs/apk/release/app-release.apk')
if (!existsSync(apk)) {
  console.error('没找到 release 包：' + apk)
  process.exit(1)
}
const out = resolve(here, `../../app/release/云笔记 ${version}.apk`)
copyFileSync(apk, out)
console.log('APK：' + out)
