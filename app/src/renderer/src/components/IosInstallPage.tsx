import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { session } from '@/lib/api'
import { isIOS, isStandalone } from '@/lib/platform'
import { useStore } from '@/lib/store'
import { IconApple, IconBack, IconCloud, IconDownload } from './Icons'

/**
 * iPhone / iPad 的安装页（#/ios）。
 *
 * iOS 上没有 App Store 版本，也装不了没签名的原生包，走的是「描述文件」：
 * 一个 .mobileconfig 把网页版作为全屏图标装到主屏幕，功能和网页版一模一样。
 * 这一页把整个流程一步步画出来——描述文件的安装入口藏在「设置」顶部，第一次装的人基本找不到。
 *
 * 电脑上打开这一页会多一个二维码：用 iPhone 的 Safari 扫一下就到同一页，接着照着做。
 */
export function IosInstallPage({ onBack }: { onBack: () => void }) {
  const profileUrl = `${session.server}/api/ios.mobileconfig`
  const site = location.origin + location.pathname.replace(/\/[^/]*$/, '/')
  const pageUrl = site + '#/ios'
  const showToast = useStore((s) => s.showToast)
  const [qr, setQr] = useState('')

  useEffect(() => {
    if (isIOS) return
    void QRCode.toString(pageUrl, { type: 'svg', margin: 1, color: { dark: '#1a1c20', light: '#0000' } })
      .then(setQr)
      .catch(() => setQr(''))
  }, [pageUrl])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pageUrl)
      showToast({ message: '网址已复制，发到 iPhone 上用 Safari 打开' })
    } catch {
      showToast({ message: '复制失败，手动选中网址复制吧' })
    }
  }

  return (
    <div className="ios-page">
      <header className="ios-top">
        <button className="icon-btn" onClick={onBack} title="返回" aria-label="返回">
          <IconBack size={20} />
        </button>
        <span className="brand">
          <IconCloud size={15} className="brand-mark" />
          云笔记
        </span>
      </header>

      <main className="ios-main">
        <section className="ios-hero">
          <div className="ios-hero-icon">
            <IconApple size={30} />
          </div>
          <h1>在 iPhone 上安装云笔记</h1>
          <p>
            iPhone 上没有 App Store 版本。用苹果的「描述文件」把云笔记装到主屏幕：
            图标、全屏、离线打开都和 App 一样，数据和网页版、桌面端实时同步。
          </p>

          {isStandalone ? (
            <div className="ios-done">你已经在主屏幕版本里了，不用再装。</div>
          ) : isIOS ? (
            <a className="btn-primary ios-cta" href={profileUrl}>
              <IconDownload size={17} />
              下载描述文件
            </a>
          ) : (
            <div className="ios-qr">
              {qr ? (
                <div className="ios-qr-img" dangerouslySetInnerHTML={{ __html: qr }} />
              ) : (
                <div className="ios-qr-img is-empty" />
              )}
              <div className="ios-qr-text">
                <b>用 iPhone 的 Safari 扫这个码</b>
                <span>会打开同一页，接着按下面的步骤做。也可以把网址发到手机上：</span>
                <span className="ios-url">
                  <code>{pageUrl}</code>
                  <button className="btn-ghost" onClick={() => void copy()}>
                    复制
                  </button>
                </span>
              </div>
            </div>
          )}
        </section>

        <ol className="ios-steps">
          <Step
            n={1}
            title="在 Safari 里点「下载描述文件」"
            desc="一定要用 Safari（微信、Chrome 里打不开描述文件）。点了之后 Safari 会问「此网站正尝试下载一个配置描述文件，是否允许？」，选「允许」。"
            art={<ArtAllow />}
          />
          <Step
            n={2}
            title="打开「设置」，点顶部的「已下载描述文件」"
            desc="下载完 Safari 会提示「描述文件已下载，如要安装请在设置中检查」。回到桌面打开「设置」，最上面（你的名字下方）多了一行「已下载描述文件」，点进去。"
            art={<ArtSettings />}
          />
          <Step
            n={3}
            title="点右上角「安装」，输入锁屏密码"
            desc="页面会标「未验证」——这是因为描述文件没有用苹果开发者证书签名，属于正常现象，不影响使用。连点两次「安装」，输一次锁屏密码即可。"
            art={<ArtInstall />}
          />
          <Step
            n={4}
            title="回到主屏幕，点「云笔记」"
            desc="主屏幕最后一页会出现「云笔记」图标，点开就是全屏的应用，登录一次以后记住账号。以后不想要了，在 设置 → 通用 → VPN 与设备管理 里移除即可。"
            art={<ArtHome />}
          />
        </ol>

        <section className="ios-faq">
          <h2>常见问题</h2>
          <dl>
            <dt>「已下载描述文件」找不到？</dt>
            <dd>它只在下载后的几分钟内显示在「设置」顶部；找不到就回 Safari 重新点一次「下载描述文件」，然后马上去设置。</dd>
            <dt>提示「未验证」安全吗？</dt>
            <dd>这个描述文件只做一件事：往主屏幕加一个指向本站的图标，不改任何系统设置，不装证书。「未验证」只是说没花钱买苹果的签名。</dd>
            <dt>和直接在 Safari「添加到主屏幕」有什么区别？</dt>
            <dd>效果一样。描述文件的好处是一个按钮就装好，不用去找分享菜单，图标和名字也不会被裁。</dd>
            <dt>能收到推送、能离线用吗？</dt>
            <dd>没有推送。离线时能打开、能看能写，联网后自动同步，和网页版一致。</dd>
          </dl>
        </section>
      </main>
    </div>
  )
}

function Step({ n, title, desc, art }: { n: number; title: string; desc: string; art: React.ReactNode }) {
  return (
    <li className="ios-step">
      <div className="ios-step-art">{art}</div>
      <div className="ios-step-text">
        <span className="ios-step-n">{n}</span>
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>
    </li>
  )
}

/* ---------- 图示：统一画在一个 220×300 的手机框里，颜色全走 CSS 变量，深浅色都对 ---------- */

function Phone({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 220 300" className="ios-art" aria-hidden="true">
      <rect x="10" y="6" width="200" height="288" rx="26" className="art-phone" />
      <rect x="18" y="14" width="184" height="272" rx="20" className="art-screen" />
      <rect x="82" y="20" width="56" height="8" rx="4" className="art-notch" />
      {children}
    </svg>
  )
}

/** 步骤 1：Safari 弹出「允许下载描述文件」 */
function ArtAllow() {
  return (
    <Phone>
      {/* 地址栏 */}
      <rect x="30" y="40" width="160" height="16" rx="8" className="art-chip" />
      <rect x="44" y="46" width="70" height="4" rx="2" className="art-line" />
      {/* 登录页大意 */}
      <rect x="40" y="76" width="70" height="8" rx="4" className="art-line strong" />
      <rect x="40" y="94" width="140" height="18" rx="6" className="art-field" />
      <rect x="40" y="118" width="140" height="18" rx="6" className="art-field" />
      <rect x="40" y="146" width="140" height="20" rx="7" className="art-accent" />
      {/* 遮罩 + 对话框 */}
      <rect x="18" y="14" width="184" height="272" rx="20" className="art-dim" />
      <rect x="40" y="150" width="140" height="92" rx="12" className="art-dialog" />
      <rect x="56" y="166" width="108" height="6" rx="3" className="art-line strong" />
      <rect x="56" y="178" width="96" height="5" rx="2.5" className="art-line" />
      <rect x="56" y="188" width="72" height="5" rx="2.5" className="art-line" />
      <line x1="40" y1="206" x2="180" y2="206" className="art-sep" />
      <line x1="110" y1="206" x2="110" y2="242" className="art-sep" />
      <text x="75" y="228" className="art-text muted">忽略</text>
      <text x="145" y="228" className="art-text accent">允许</text>
      <circle cx="145" cy="225" r="18" className="art-ring" />
    </Phone>
  )
}

/** 步骤 2：设置顶部的「已下载描述文件」 */
function ArtSettings() {
  return (
    <Phone>
      <text x="32" y="52" className="art-title">设置</text>
      {/* 头像行 */}
      <rect x="30" y="64" width="160" height="34" rx="10" className="art-card" />
      <circle cx="48" cy="81" r="10" className="art-avatar" />
      <rect x="64" y="74" width="60" height="6" rx="3" className="art-line strong" />
      <rect x="64" y="86" width="90" height="4" rx="2" className="art-line" />
      {/* 已下载描述文件 */}
      <rect x="30" y="106" width="160" height="26" rx="10" className="art-card hot" />
      <rect x="40" y="113" width="12" height="12" rx="3" className="art-accent" />
      <text x="58" y="123" className="art-text">已下载描述文件</text>
      <text x="176" y="123" className="art-text muted">›</text>
      <circle cx="110" cy="119" r="0" />
      <rect x="26" y="102" width="168" height="34" rx="12" className="art-ring" />
      {/* 其它设置行 */}
      <rect x="30" y="144" width="160" height="26" rx="10" className="art-card" />
      <rect x="40" y="151" width="12" height="12" rx="3" className="art-icon" />
      <rect x="58" y="154" width="50" height="5" rx="2.5" className="art-line" />
      <rect x="30" y="174" width="160" height="26" rx="10" className="art-card" />
      <rect x="40" y="181" width="12" height="12" rx="3" className="art-icon" />
      <rect x="58" y="184" width="64" height="5" rx="2.5" className="art-line" />
      <rect x="30" y="204" width="160" height="26" rx="10" className="art-card" />
      <rect x="40" y="211" width="12" height="12" rx="3" className="art-icon" />
      <rect x="58" y="214" width="40" height="5" rx="2.5" className="art-line" />
    </Phone>
  )
}

/** 步骤 3：安装描述文件页，右上角「安装」 */
function ArtInstall() {
  return (
    <Phone>
      <text x="32" y="52" className="art-text muted">取消</text>
      <text x="80" y="52" className="art-text strong">安装描述文件</text>
      <text x="160" y="52" className="art-text accent">安装</text>
      <circle cx="170" cy="49" r="16" className="art-ring" />
      <rect x="30" y="72" width="160" height="60" rx="12" className="art-card" />
      <rect x="42" y="84" width="24" height="24" rx="7" className="art-accent" />
      <text x="74" y="94" className="art-text strong">云笔记</text>
      <rect x="74" y="102" width="70" height="4" rx="2" className="art-line" />
      <rect x="74" y="112" width="52" height="4" rx="2" className="art-line" />
      <rect x="30" y="140" width="160" height="26" rx="10" className="art-card" />
      <text x="40" y="157" className="art-text muted">已签名</text>
      <text x="138" y="157" className="art-text warn">未验证</text>
      <rect x="30" y="170" width="160" height="26" rx="10" className="art-card" />
      <text x="40" y="187" className="art-text muted">包含</text>
      <text x="120" y="187" className="art-text">Web Clip</text>
      <text x="30" y="216" className="art-text muted small">「未验证」是正常的，放心装</text>
    </Phone>
  )
}

/** 步骤 4：主屏幕上出现云笔记图标 */
function ArtHome() {
  const cells: React.ReactNode[] = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const x = 34 + c * 40
      const y = 48 + r * 46
      const isOurs = r === 2 && c === 1
      cells.push(
        <g key={`${r}-${c}`}>
          <rect x={x} y={y} width="30" height="30" rx="8" className={isOurs ? 'art-accent' : 'art-icon'} />
          {isOurs && (
            <path
              d="M7.2 18.5A4.2 4.2 0 0 1 6.6 10a5.6 5.6 0 0 1 10.8-1.2 3.9 3.9 0 0 1-.6 9.7z"
              transform={`translate(${x + 5} ${y + 5}) scale(0.83)`}
              className="art-cloud"
            />
          )}
          <rect x={x + 5} y={y + 35} width="20" height="3" rx="1.5" className={isOurs ? 'art-line strong' : 'art-line'} />
        </g>
      )
    }
  }
  return (
    <Phone>
      {cells}
      <rect x="68" y="134" width="42" height="50" rx="12" className="art-ring" />
      <rect x="30" y="252" width="160" height="26" rx="13" className="art-chip" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={40 + i * 38} y="257" width="16" height="16" rx="5" className="art-icon" />
      ))}
    </Phone>
  )
}
