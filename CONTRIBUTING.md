# 参与贡献

[English](CONTRIBUTING.en.md) | **简体中文**

先谢谢你愿意花时间。这份文档写的是把项目跑起来、改完怎么自检、以及提 Issue / PR 时希望你附上什么。

## 环境

**Node 24 或更高。** 服务端用了 Node 内置的 `node:sqlite`，低版本起不来（启动时会有明确提示，不会甩一堆模块解析错误）。

```bash
git clone https://github.com/jxwine/cloudnote.git
cd cloudnote
npm run install:all   # 装服务端和客户端的依赖
npm run dev           # 同时起同步服务和桌面客户端
```

首次打开点「创建一个」注册账号即可，数据默认落在 `server/data/`。

也可以分开跑：

```bash
npm run server        # 只跑同步服务（默认 http://localhost:4471）
npm run app           # 只跑桌面客户端
```

> 客户端的 `userData` 目录名取自 `app/package.json` 的 `name`，安装版和开发版是同一个。
> 所以**开发前请先退出已安装的客户端**，否则单实例锁会让开发版直接退出、没有任何提示。

## 项目结构

```
server/          同步服务：Fastify + node:sqlite + WebSocket
  src/db.js        表结构、事务、每用户单调递增的变更序号
  src/auth.js      注册登录、JWT、鉴权与管理员钩子
  src/routes.js    全部接口。公开路由 / priv（要登录）/ admin（要管理员）三个作用域
  src/hub.js       按账号分组的 WebSocket 广播
  src/uploads.js   图片落盘与读取
  src/releases.js  客户端安装包落盘与读取
  test/e2e.js      端到端测试
app/             Electron 客户端（网页版也是这份构建产物）
  src/main/        主进程：窗口、托盘、主题、更新下载
  src/preload/     渲染进程与主进程之间的桥
  src/renderer/
    lib/sync.ts      同步引擎：防抖保存、冲突归档、离线队列
    lib/store.ts     全局状态与本地缓存
    components/      界面
deploy/          部署脚本与 Nginx 配置
```

## 改完怎么自检

### 类型检查

```bash
cd app && npm run typecheck
```

`tsconfig.json` 开了 `strict` **和 `noUnusedLocals`**——留了个没用到的变量也会直接编译失败，别奇怪。

> 项目目前**没有配 ESLint**，所以没有 `npm run lint` 可跑。风格上跟着周围代码走就行。

### 服务端端到端测试

测试是一个打真实 HTTP + WebSocket 的裸脚本，**要先把服务跑起来**：

```bash
npm run server        # 另开一个终端
npm test              # 71 项
```

后台管理相关的那几项需要服务端认得出管理员，否则会整段跳过并打印提示：

```bash
CLOUDNOTE_ADMINS=admin@test.local npm run server
npm test
```

测试数据靠时间戳生成唯一邮箱来隔离，**不会自动清理**，跑多了开发库会攒下一堆账号，介意就删掉 `server/data/cloudnote.db` 重来。

### 涉及界面的改动

界面的东西请**在真实窗口里点一遍**再提 PR。类型过了不代表能用——这个项目里踩过的坑包括：浮层被裁掉、拖拽高亮不出现、遮罩盖住系统窗口按钮导致色差。这些静态检查一个都发现不了。

## 提 PR

1. 从 `main` 切一个分支
2. 一个 PR 只做一件事，别把重构和修 bug 混在一起
3. 提交信息用中文，**写清楚为什么这么改**，不只是改了什么——这个项目的提交历史和代码注释都遵循这个习惯
4. PR 描述里说明你怎么验证的（跑了哪些测试、在界面上点了什么）

**要打包安装程序的话**，先把 `app/package.json` 的 `version` 提一位。版本号不变，装了旧版的人收不到更新提示，后台里也没法再发一条同版本号的记录。

## 不要提交进来的东西

`.gitignore` 已经挡住了，但还是说一下：

- `server/.env` —— 含签名密钥
- `server/data/` —— 数据库、上传的图片、安装包
- `app/out/`、`app/release/` —— 构建产物
- `cloudnote-update/` —— 准备上传到服务器的部署产物

## 报 Bug

请附上：

- **客户端版本**（账号菜单 → 关于，或者安装包文件名里的版本号）和操作系统版本
- **复现步骤**，越具体越好。「点了工具栏某个按钮之后再点空白处」比「界面有问题」有用得多
- 期望的行为和实际的行为
- 如果是同步相关的问题，说明当时有几台设备在线、分别在做什么（浏览还是编辑）
- 截图或录屏

同步和冲突这块的行为不太直观，报之前可以先看一眼 README 的「同步是怎么工作的」，确认不是设计如此。

## 提功能建议

这个项目刻意保持克制——比如颜色只给一小组预设、标题只在两个时刻自动取。提建议时说说**你遇到的具体场景**，比直接给方案更容易讨论。
