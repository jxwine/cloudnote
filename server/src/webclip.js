import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * iOS 的「描述文件」安装：生成一个 Web Clip 配置描述文件。
 *
 * iPhone 上装不了我们的原生包（没上架、没开发者证书），退而求其次：
 * 用 .mobileconfig 把网页版作为一个全屏图标装到主屏幕，效果和「添加到主屏幕」一样，
 * 但可以从登录页一个按钮直接装，图标 / 名称 / 全屏都由我们定。
 * 未签名的描述文件在安装页会显示「未验证」，这是正常的——签名要 Apple 开发者证书。
 *
 * 域名从请求头现取（nginx 传了 host 和 x-forwarded-proto），不写死进代码；
 * UUID 由域名算出来，同一个站重复安装会覆盖而不是叠一份。
 */

const here = dirname(fileURLToPath(import.meta.url))
// 180×180 的那张苹果触控图标，直接内嵌进描述文件
const ICON_B64 = readFileSync(join(here, 'webclip-icon.png')).toString('base64')

const uuidFrom = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex').toUpperCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** @param {string} origin 例如 https://note.example.com */
export function buildWebClipProfile(origin) {
  const host = new URL(origin).host
  const name = '云笔记'
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>FullScreen</key>
      <true/>
      <key>Icon</key>
      <data>${ICON_B64}</data>
      <key>IgnoreManifestScope</key>
      <true/>
      <key>IsRemovable</key>
      <true/>
      <key>Label</key>
      <string>${esc(name)}</string>
      <key>PayloadDescription</key>
      <string>在主屏幕上添加「${esc(name)}」图标</string>
      <key>PayloadDisplayName</key>
      <string>${esc(name)}</string>
      <key>PayloadIdentifier</key>
      <string>com.cloudnote.webclip.${esc(host)}</string>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadUUID</key>
      <string>${uuidFrom('webclip:' + host)}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>Precomposed</key>
      <true/>
      <key>URL</key>
      <string>${esc(origin)}/</string>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>把 ${esc(name)} 装到主屏幕，全屏打开，随时可在「设置 → 通用 → VPN 与设备管理」里移除。</string>
  <key>PayloadDisplayName</key>
  <string>${esc(name)}（${esc(host)}）</string>
  <key>PayloadIdentifier</key>
  <string>com.cloudnote.profile.${esc(host)}</string>
  <key>PayloadOrganization</key>
  <string>${esc(host)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuidFrom('profile:' + host)}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`
}
