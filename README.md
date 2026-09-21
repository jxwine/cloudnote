# 云笔记 CloudNote

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Web%20%7C%20Android-lightgrey.svg)](#)

[English](README.en.md) | **简体中文**

自托管的桌面云笔记：左侧目录树、中间编辑器、右侧自动大纲，多端实时同步。

数据全在你自己的服务器上——一个 Node 进程加一个 SQLite 文件，没有原生模块、
没有外部数据库、没有第三方服务。

![界面](screenshot-light.png)

## 它能做什么

- **三栏界面**，左右两栏都能收起，宽度可拖
- **实时同步**：WebSocket 推送，另一端在看就热更新，在写就把云端那版归档成冲突副本，两份都不丢
- **离线可用**：断网期间照常编辑，恢复连接后重放队列并增量对账
- **Markdown 式编辑**：Tiptap/ProseMirror，输入即时生效，选中浮出格式栏，图片粘贴/拖入即传
- **组织**：目录树拖拽归档与同级排序、标签交叉分类、全文搜索、`Ctrl+P` 快速跳转
- **兜底**：软删除回收站、自动版本快照与恢复、Markdown 导出
- **常驻托盘**：点关闭只收起窗口，程序留在系统托盘继续接收同步
- **自动更新**：客户端自己发现新版本，应用内下载、校验 sha256、拉起安装程序
- **网页后台**：管理账号、发布客户端版本，网页端还能直接下载安装包
- **网页版**：同一份前端代码，浏览器直接用，和桌面端实时互通；手机上是卡片首页 + 全屏编辑页，平板上大纲收成抽屉，可「添加到主屏幕」
- **安卓端**：网页版手机档装进 Capacitor 壳打成 APK，后台发布、App 内更新；iPhone 走描述文件装到主屏幕

## 技术栈

| | |
|---|---|
| 桌面端 | Electron + electron-vite + React 18 + TypeScript |
| 安卓端 | Capacitor 7 把网页版手机档装进 WebView 壳，同一份构建产物 |
| 编辑器 | Tiptap 3（ProseMirror） |
| 服务端 | Fastify 5 + `node:sqlite`（Node 24 内置）+ `@fastify/websocket` |
| 同步 | 每篇笔记单调递增 `version` 做乐观锁，每账号 `seq` 游标做增量拉取 |

## 快速开始

```bash
npm run install:all   # 安装服务端与客户端依赖
npm run dev           # 同时启动同步服务和桌面客户端
```

首次打开点「创建一个」注册账号即可。服务默认跑在 `http://localhost:4471`，
想连自建服务器时在登录页点「换一个同步服务」填地址。

单独启动：

```bash
npm run server        # 只跑同步服务
npm run app           # 只跑桌面客户端
npm test              # 服务端端到端测试（76 项）
npm run dist          # 打包 Windows 安装程序到 app/release
```

## 结构

```
note/
├── server/           同步服务：Fastify + node:sqlite + WebSocket
│   ├── src/db.js       表结构、事务、每用户单调递增的变更序号
│   ├── src/uploads.js  图片落盘与读取
│   ├── src/auth.js     注册登录、JWT、鉴权钩子
│   ├── src/routes.js   目录与笔记接口，版本乐观锁
│   ├── src/hub.js      按账号分组的 WebSocket 广播
│   └── test/e2e.js     端到端测试
└── app/              Electron 客户端
    ├── src/main/       主进程：窗口、主题、打包版内置服务
    ├── src/preload/    渲染进程与主进程之间的安全桥
    └── src/renderer/
        ├── lib/sync.ts     同步引擎：防抖保存、冲突归档、离线队列
        ├── lib/store.ts    全局状态与本地缓存
        ├── lib/outline.ts  标题提取与滚动定位
        ├── lib/images.ts   图片上传（粘贴 / 拖入 / 选择文件）
        └── components/     三栏界面 + mobile/ 手机外壳
└── android/          安卓端：Capacitor 壳，www/ 来自 app/out/renderer
    ├── capacitor.config.ts
    ├── android/        原生工程（gradle），MainActivity 只多了一段键盘 inset 处理
    ├── scripts/        setup-sdk.ps1 装 SDK、build-www.mjs 准备 www/、collect-apk.mjs 收产物
    └── keystore/       签名密钥（jks 和口令不进仓库，务必备份）
```

## 目录树

新建目录和子目录、重命名、删除，右键或行尾的按钮都能操作。

拖拽按光标落在行内的高度决定意图：

- **贴上下边缘** → 排到那一项的前面 / 后面，同级重新排序，出现一条带圆点的插入线
- **落在目录中间** → 放进这个目录，整行会圈一个描边
- **拖到列表空白处** → 移出目录，回到根层级
- 拖着悬停在折叠的目录上一会儿，它会自动展开，方便往深处放

目录不能拖进自己的子目录里。排序结果会同步到所有设备。

## 标签、回收站与历史

**标签**：笔记标题上方可以加标签，输入时会提示已用过的标签，免得同一个概念写出好几种。
侧栏「标签」页签列出所有标签和各自的篇数，点一个就只看它；从笔记里点标签同样能筛。
目录是单一归属，标签用来做交叉分类。

![标签](screenshot-tags.png)

**回收站**：删除是软删除，笔记先进回收站。标题栏的回收站按钮进去（带待清理篇数），
可以放回去，也可以彻底删除（不可撤销）。再点一次按钮退回笔记列表。

![回收站](screenshot-trash.png)

**历史版本**：正文改动会自动留存快照——每隔几分钟最多一版，每篇保留最近 40 版，
所以连续打字不会把历史刷满。笔记右上角「历史版本」可以逐版预览并恢复；
恢复时当前内容也会存成一版，随时能退回来。

**导出**：单篇（笔记右键 → 导出为 Markdown）、按目录（目录右键 → 导出这个目录）、
全部（侧栏顶部的导出按钮）。批量导出会按笔记原来的目录层级铺开成文件夹，同名笔记自动加序号。

## 查找与替换

在编辑器里按 `Ctrl+F`（或 `Ctrl+H`）打开，查找和替换在同一个条里，不分两种模式。
打开时如果正文里有选中的文字，会自动拿它当查找词；已经开着时再按一次，查找词会跟着
当前选中的内容更新。

![查找替换](screenshot-find.png)

| 操作 | 快捷键 |
|---|---|
| 下一处 | `Enter` |
| 上一处 | `Shift+Enter` |
| 关闭 | `Esc` |

命中处全部标黄，当前那一处用强调色标出并自动滚到视野中央，右侧显示 `3/12` 这样的计数。
「替换」只改当前一处，「全部替换」改完会提示替换了多少处。关闭时高亮自动清除。

这只在当前这篇笔记里找；跨笔记检索用左上角的搜索框。

## 快速跳转与搜索

`Ctrl+P` 打开快速跳转，输入标题片段即可。匹配是**跳字**的——只要你敲的字按顺序出现在标题里
就算命中，不必连续，所以敲 `同纪` 就能找到「同步方案评审纪要」。上下键选，回车打开。

![快速跳转](screenshot-jump.png)

## 搜索

![搜索](screenshot-search.png)

在左上角搜索框输入即可全文检索，标题和正文都算。结果按相关度排：标题命中的排在最前，
其次看正文里命中的次数，最后按修改时间。

每条结果给出命中处的上下文（关键词标黄）、笔记所在的目录路径和修改日期，右上角的数字
是这篇里命中了多少处。点一条就打开那篇笔记，正文里所有命中都标黄，页面直接定位到第一处——
落点那一处用强调色实心标出，和其余命中区分开。清空搜索框，高亮随之消失。

## 同步是怎么工作的

**保存**：编辑停顿 700ms 后自动提交，`Ctrl+S` 立即提交。不是每敲一个字发一次请求——
连续打字时定时器一直顺延，只有停手才发；但也不会无限顺延，同一篇最多攒 5 秒就强制落一次，
免得一口气写十分钟服务器上什么都没有。同一篇同时只允许一个请求在途，中途的改动合并到下一次，
不会出现两个请求带着同样的版本号撞成冲突。

每条笔记带一个单调递增的 `version`，提交时把手上这份的版本号一起发给服务端。

**推送**：服务端写库成功后，通过 WebSocket 把新内容推给同账号的其他设备，
发起方自己不会收到回声。

**冲突**：两端同时改一篇笔记时，规则是 **本地编辑永远保留，云端版本完整归档**。

- 对方改动到达时，如果你没在编辑这篇 → 正文直接热更新，你正看着就能看到变化。
- 如果你正在编辑 → 你的内容原样不动，对方那一版被存成一条「XXX（云端版本 时间）」
  笔记出现在同一目录下，编辑区上方给出提示，点提示可以直接跳过去对照。
- 60 秒内的连续冲突复用同一条副本，不会刷屏。

![冲突副本](screenshot-conflict.png)

这样两个版本都不会丢，合并与否由你自己决定。

**离线**：断网时新建、删除、移动进本地队列并持久化，正文改动留在内存里；
恢复连接后先重放队列，再补发正文，最后做一次增量拉取对账。
增量拉取靠每用户的 `seq` 游标，只取变化的部分。

## 标题

编辑区顶部是笔记标题，它是笔记自己的属性，不算正文的一部分（所以不会出现在大纲里）。

规则是 **标题为空才自动取，取到就不再动**。自动取的时机只有两个：

- 按 `Ctrl+S`
- 切走这篇笔记，或者关掉窗口

平时打字完全不碰标题——正文首行在敲的过程中是「h」「he」这种中间态，那时取等于把
半成品当成了笔记名。等你按保存或者写完离开，内容定下来了再取，取到就固定住，之后
无论怎么改正文都不会被顶掉。想重新取就把标题清空，下一次保存会补上。

中文输入法的合成期同样不落库，拼音打到一半不会被存成标题。

侧栏右键「重命名」和这个标题框是同一个东西，改哪边都一样。

## 编辑器

基于 Tiptap（ProseMirror），Markdown 式输入即时生效：

| 输入 | 结果 | | 输入 | 结果 |
|---|---|---|---|---|
| `# ` | 一级标题 | | `> ` | 引用 |
| `## ` | 二级标题 | | ` ``` ` | 代码块（含高亮） |
| `- ` | 无序列表 | | `1. ` | 有序列表 |
| `[] ` | 待办项 | | `---` | 分隔线 |

**选中文字**会浮出一条格式栏，就地改格式，不用把手移回顶部：

![浮动格式栏](screenshot-bubble.png)

顶部工具栏有同样这批能力，外加列表、引用和插入菜单。清除格式排在最前面。

**颜色**给了一小组预设色——文字色取的是中间调，同一篇笔记在浅色和深色下都不会糊掉。
预设不够用就点「自定义颜色…」，展开完整取色板：饱和度/明度色域、色相条、透明度条，
以及 HEX 和 RGBA 数值输入，四种方式改的是同一个颜色，改哪个另外几个都跟着走。
文字色和背景高亮共用这一套。

按住 `Ctrl` 单击链接会交给系统浏览器打开；不按修饰键就是普通的放光标编辑。
只有 http/https/mailto/ftp 会被放行，笔记里混进 `javascript:` 之类打不开。

插入链接时，如果选中的文本本身就是个网址或邮箱，地址会自动填好——
`www.baidu.com` 补成 `https://www.baidu.com`，`someone@example.com` 补成
`mailto:` 形式，直接回车即可。

**图片**支持直接粘贴、拖入，或从插入菜单选文件上传。图片一律先传到服务端再
插入链接，不会以 base64 塞进正文——内嵌会让笔记体积暴涨，每次保存都要把整张
图重传一遍。单张上限 10MB，支持 png / jpg / gif / webp / svg / bmp / avif。

正文宽度跟着窗口走，左右留白按比例增长。右侧大纲实时跟随正文标题，
点击跳转，滚动时高亮当前位置。

外观在右上角的设置里选：跟随系统 / 浅色 / 深色。选定后会记住，下次打开还是这个。

![深色主题](screenshot-dark.png)

## 客户端更新

服务端有一份「发布包」清单，客户端启动 8 秒后静默查一次、之后每 6 小时一次，
设置的「关于」里也能手动「检查更新」，那儿一并显示当前版本号。

发现新版本会弹一个框，把你在后台填的更新说明**原样**显示出来。点「立即更新」就在应用内
下载，带进度条；下完先校验 sha256，对不上就删掉文件并提示重试，绝不会把一个来路不明的
exe 递给你双击。校验通过才拉起安装程序并退出自己（NSIS 装的时候要求覆盖正在运行的程序）。

### 热更新（2 MB 而不是 84 MB）

安装包里我们自己的代码只有 2 MB（`resources/app.asar`），其余全是 Electron 运行时。
所以日常发版不发整包，发一个热更新包：`npm run dist` 会在打出 exe 的同时把 `out/ + build/ + package.json`
打成 `release/云笔记 热更新 <version>.asar`，在后台上传它（和 exe 走两条独立通道）。

客户端这边，`package.json` 的 `main` 指向 `out/main/loader.js`：启动时看 `userData/updates/` 里有没有
比自带版本新、Electron 主版本对得上的包，有就从那份 `require` 主进程（preload、渲染层、托盘图标
都跟着那份走），没有就用安装包里的。检查更新时优先热更新，只有热更新给不了
（Electron 大版本变了、或者用户装的是没有 loader 的老版本）才提示下载整包。

几条约束，都是真机踩出来的：

- Windows 上正在运行的 asar **删不掉但能被覆盖写**。所以下载永远写新文件名
  （`<version>.download` → 校验通过改名 `<version>.asar`），绝不原地覆盖，旧包留到下次启动再清。
- 看一个包的 `package.json` 不能走 Electron 的 asar 钩子——那套会把句柄缓存到进程退出，
  文件就删不掉了；而且钩子把 `x.asar` 本身当目录，直接 `open` 会失败。`src/main/asar.ts`
  是一个 40 行的裸读取器，读之前把 `process.noAsar` 打开。
- 崩溃保护：loader 加载前写 `updates/booting.json`，主进程出首帧后删掉；下次启动发现还在，
  就把那个包改名 `.bad` 并记进拒绝名单，回退到自带版本。主模块加载时就抛异常的包也走这条路
  （relaunch 一次，不在同一个进程里再加载自带的，否则会叠出两份窗口）。
- 包里 `cloudnote.electron` 声明它是对着哪个 Electron 构建的，和运行时主版本不符的包
  下载完就丢掉并记住版本，不会每 6 小时白下一次。
- 版本号从自己头顶的 `package.json` 读，不用 `app.getVersion()`——后者永远是安装包那份的。

没接 `electron-updater`：它要求服务端按它的格式放 `latest.yml` 和 blockmap，未签名的应用
还得关掉签名校验，为这点收益多一个依赖不划算；而且它的差分下载是对 NSIS 包做块级 diff，
实测远不如直接换 asar。

网页版没有这一套，取而代之的是下载入口：登录页、顶栏和设置「关于」里一排平台图标——电脑上
安卓 / Windows / iPhone 三个，手机浏览器里只给自己那个；安卓和 Windows 只在服务器上发过那个通道时才出现。

iPhone 那项进的是安装页 `#/ios`：iOS 上没有 App Store 版本，走苹果的「描述文件」（`GET /api/ios.mobileconfig`，
服务端按请求域名现生成一个 Web Clip）把网页装到主屏幕，图标 / 全屏和 App 一样。页面上有四步图示，
电脑打开会显示二维码让手机扫。描述文件没签名会标「未验证」，属正常（签名要 Apple 开发者证书）。

### 三条通道

后台「发布新版本」按文件扩展名认客户端类型（下拉框预选好，也能手改），服务端只收这三种：

| 通道 | 文件 | 谁看它 |
|---|---|---|
| `win32` | `.exe` 整包 | 桌面端（热更新给不了时）、网页下载入口 |
| `win32-asar` | `.asar` 热更新 | 桌面端优先 |
| `android` | `.apk` | 安卓端、网页下载入口 |

各端检查更新只看自己的通道：发了安卓包，桌面端不会弹；反过来也一样。

### 安卓端更新

安卓壳里同样是启动 8 秒后查一次、每 6 小时一次，关于页也能手动查。发现新版本 → 「立即更新」
→ 用 Filesystem 插件把 APK 下到 App 的缓存目录（带进度）→ 交给系统安装页（`android/…/InstallerPlugin.java`，
经 FileProvider 拉起 `ACTION_VIEW`）。第一次系统会要求允许「安装未知应用」，跟着提示开一下就行。
APK 不做 sha256 校验——安卓自己会验签名，签名对不上根本装不进去。

## 安卓端

安卓端不是另写的一套：它把网页版的手机档（卡片首页 + 全屏编辑页）装进 Capacitor 的 WebView 壳，
同步、编辑、冲突处理和桌面端 / 网页版是同一份代码。网页改了，重新打包就是新版 App。

**一次性准备**（Windows，不需要 Android Studio）：

```powershell
# 装 JDK 17+（本机有 jdk-23 即可），然后：
powershell -ExecutionPolicy Bypass -File android/scripts/setup-sdk.ps1   # cmdline-tools + platform-tools + android-35 + build-tools，约 700 MB
npm --prefix android install
```

签名密钥：按 `android/keystore/README.md` 生成 `cloudnote.jks` 和 `keystore.properties`。
**这个 jks 丢了，以后的包就不能覆盖安装到老用户手机上**，生成后立刻备份。

**出包**：

```bash
VITE_CLOUDNOTE_SERVER=https://note.example.com npm --prefix app run build   # 网页产物，带上你的服务器地址
npm --prefix android run build     # 拷进 www/、改一处 CSP、cap sync
npm --prefix android run apk       # gradlew assembleRelease → app/release/云笔记 <版本>.apk
```

版本号跟 `app/package.json` 走（`versionCode` = 主×10000 + 次×100 + 修）。
第一次 `gradlew` 会自己下 Gradle 8.11 和一份 JDK 21（有插件指定要它编译）。

**和网页版的差别**（都在 `lib/platform.ts` 的 `isNative` 分支里）：

- 导出 Markdown 走系统分享面板（WebView 下不了 blob:），存网盘 / 发微信 / 保存到文件都行。
- 允许连 `http://` 的自建服务（`usesCleartextTraffic` + `allowMixedContent`），局域网自建不用配证书。
- Android 15 起系统强制边到边，`adjustResize` 失效，`MainActivity` 自己把键盘高度算进 WebView 的底边距，
  编辑器的格式工具栏才能贴在键盘上方。

安卓返回键：编辑页退回首页，首页再按一次退出。iOS 没做（没有 Mac）。

## 后台管理

**只在网页版开放**——它是运维用的，浏览器里开就行，没必要占客户端的入口。

管理员由 `server/.env` 里的 `CLOUDNOTE_ADMINS` 决定（逗号分隔的邮箱），用现有的笔记账号
登录，命中名单就能在顶栏看到「后台管理」。

故意不做成数据库里的角色：权限不会被界面误改，丢了权限 SSH 改一行重启就回来了。
代价是加减管理员要重启服务。

| 页面 | 能做什么 |
|---|---|
| 用户 | 看邮箱、昵称、注册时间、最后活跃、笔记数、在线设备；停用/启用、重置密码、删除账号 |
| 客户端版本 | 上传安装包（.exe / .asar / .apk 三种类型，带进度）、写更新说明、上下架、删除 |

几条护栏：管理员不能停用或删除自己；删除账号要手输目标邮箱确认，服务端会再校验一次；
停用会立刻踢掉该账号所有 WebSocket 连接，已发出去的 token 下一个请求就失效。

删除账号是**硬删**——笔记、目录、历史版本、上传的图片一并清掉，不进回收站，不可恢复。

## 窗口与托盘

点标题栏的关闭按钮**不会退出程序**，只是把窗口收进系统托盘（任务栏右下角）。
这样后台的 WebSocket 连着，别的设备改了笔记这边照样能收到，下次打开不用重新拉一遍。

- **单击**托盘图标 → 把窗口叫回来
- **右键**托盘图标 → 「打开云笔记」/「退出」，要彻底退出走这里

第一次收进托盘时会弹一条气泡提示，免得你以为程序被自己关掉了。

程序只允许跑一个实例。窗口收起来之后再去点桌面快捷方式，不会起第二个，而是把已有的窗口叫到前台——
否则打包版会再启一个本地服务去抢同一个端口。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+D` | 新建笔记 |
| `Ctrl+P` | 快速跳转到某篇笔记 |
| `Ctrl+S` | 立即保存 |
| `Ctrl+\` | 开合左侧目录栏 |
| `Ctrl+Shift+/` | 开合右侧大纲栏 |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+U` | 加粗 / 斜体 / 下划线 |
| `Ctrl+K` | 插入链接 |
| `Ctrl+F` | 查找替换 |
| `Ctrl` + 单击链接 | 用系统浏览器打开 |

## 数据清理

删除是软删除——多端同步靠这条记录传递「它没了」，图片也不会跟着笔记删（笔记可能被撤销恢复）。
时间久了这些会攒下来，用清理工具收一收：

```bash
cd server
npm run gc                      # 只报告，不动手
npm run gc -- --apply           # 真正清理
npm run gc -- --days 90 --apply # 软删超过 90 天的才清（默认 30 天）
```

它会硬删过期的软删记录、删掉没有任何笔记引用的图片，最后压缩数据库。

## 部署到自己的服务器

**装了宝塔面板的话，看 [deploy/README.md](deploy/README.md)**——那里有从装 Node 到配 HTTPS
的完整步骤，以及一条命令搞定服务端的脚本。

手动部署也简单，服务端是个普通 Node 进程（要 **Node 24+**，因为用了内置的 SQLite）：

```bash
cd server && npm install --omit=dev
CLOUDNOTE_SECRET=换成随机密钥 PORT=4471 npm start
```

也可以把配置写进 `server/.env`，服务启动时会自己读。

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `4471` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `CLOUDNOTE_SECRET` | JWT 签名密钥，**上线务必修改** | 开发用默认值 |
| `CLOUDNOTE_DB` | SQLite 文件路径 | `server/data/cloudnote.db` |
| `CLOUDNOTE_UPLOADS` | 图片存放目录 | `server/data/uploads` |
| `CLOUDNOTE_AUTH_LIMIT_ID` | 单账号五分钟内允许的登录失败次数 | `5` |
| `CLOUDNOTE_AUTH_LIMIT_IP` | 单 IP 五分钟内允许的登录失败次数 | `30` |
| `CLOUDNOTE_ADMINS` | 后台管理员邮箱，逗号分隔。留空则无人能进后台 | 空 |
| `CLOUDNOTE_RELEASES` | 客户端安装包存放目录 | `server/data/releases` |

登录限流只统计**失败**，成功一次就清零，正常用户碰不到这条线。分账号和 IP 两个维度：
前者挡住针对某个账号的撞库，后者挡住换邮箱的批量扫描，又不会因为同一出口下别人输错密码
就把你锁在门外。上传另有每账号每分钟 60 张的限制。

上传的图片按 `uploads/<用户 id>/<32 位随机名>` 存盘，读取地址不鉴权——
文件名足够长，URL 本身就是凭证，这样 `<img src>` 不必携带登录头。
放公网时注意这一点：拿到链接的人就能看到那张图。

公网部署建议放在 HTTPS 反向代理后面，并确保代理转发 WebSocket 升级请求
（Nginx 需要 `proxy_set_header Upgrade $http_upgrade;` 与 `Connection "upgrade"`）。
客户端登录页把地址填成 `https://你的域名` 即可，WebSocket 会自动走 `wss://`。

想让客户端装上就默认连你的服务器，打包时注入地址：

```bash
cd app && VITE_CLOUDNOTE_SERVER=https://note.example.com npm run dist
```

发布给别人用的客户端**务必**注入这个地址。不注入的话默认连 `http://localhost:4471`，
装了包的人开机是连不上的——打包版本来会自带一份后端顶上，但那条路当前是断的：
Electron 33 内置的 Node 是 20.18.3，而服务端要用 `node:sqlite`（需要 Node 24），
fork 出来的服务起不来。注入地址后 `__USE_BUNDLED_SERVER__` 为假，不会再去 fork。

注入之后用户仍然可以改：登录页的「换一个同步服务」按钮一直都在。

## 参与

欢迎提 Issue 和 PR。动手前请看 [CONTRIBUTING.md](CONTRIBUTING.md)，那里有环境要求、
项目结构和自检清单；参与本项目也请遵守 [行为准则](CODE_OF_CONDUCT.md)。

改动后至少跑这两条：

```bash
npm run server        # 端到端测试要先把服务跑起来（另开一个终端）
npm test              # 服务端端到端，76 项（后台相关的需要 CLOUDNOTE_ADMINS=admin@test.local）
cd app && npm run typecheck
```

## 许可证

[Apache License 2.0](LICENSE)

```
Copyright 2026 jiaxing

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
