# 部署到宝塔（Ubuntu 24）

服务端是个普通的 Node 进程，没有原生模块、没有外部数据库——数据就是一个 SQLite 文件加一个图片目录。
所以部署要做的事不多，主要是三件：**Node 版本要够、密钥要换、Nginx 的 WebSocket 要配对**。

---

## 一、装 Node 24

项目用了 Node 内置的 SQLite（`node:sqlite`），**必须 Node 24 或更高**。Ubuntu 24 自带的版本不够。

宝塔面板 → 软件商店 → 搜索「Node.js 版本管理器」→ 安装 → 在里面装 **24.x** → 点「设为命令行默认版本」。

装完在终端确认：

```bash
node -v      # 要看到 v24.x.x 或更高
```

> 版本不够会怎样：服务启动时会直接告诉你「当前 Node 版本用不了内置的 node:sqlite」，
> 不会甩一堆看不懂的模块解析错误。

---

## 二、传代码

只需要 `server/` 和 `deploy/` 两个目录，客户端代码不用上传。

宝塔 → 文件 → 进入 `/www/wwwroot/` → 建目录 `cloudnote` → 把这两个目录传进去。
`node_modules` 不用传，下一步会装。

传完的样子：

```
/www/wwwroot/cloudnote/
├── server/          服务端
└── deploy/          部署配置和脚本
```

用 git 也行：

```bash
cd /www/wwwroot
git clone <你的仓库> cloudnote
```

---

## 三、一条命令装好服务

```bash
cd /www/wwwroot/cloudnote
bash deploy/setup.sh
```

它会：检查 Node 版本 → 装依赖 → **生成随机密钥**写进 `server/.env`（权限 600）→ 用 PM2 启动 → 跑一次健康检查。

重复执行是安全的，已有的密钥不会被覆盖。

看到「健康检查通过」就说明服务端好了。

### 生成的配置在哪

`server/.env`，长这样：

```ini
CLOUDNOTE_SECRET=<自动生成的随机串>   # 登录凭证的签名密钥
PORT=4471
HOST=127.0.0.1                        # 只监听回环，外网统一走 Nginx
CLOUDNOTE_DB=/www/wwwroot/cloudnote/server/data/cloudnote.db
CLOUDNOTE_UPLOADS=/www/wwwroot/cloudnote/server/data/uploads
CLOUDNOTE_AUTH_LIMIT_ID=5             # 单账号五分钟内允许的登录失败次数
CLOUDNOTE_AUTH_LIMIT_IP=30            # 单 IP 同上
```

改完要重启：`pm2 restart cloudnote`

---

## 四、建站点 + HTTPS

宝塔 → 网站 → 添加站点：

- 域名填你的域名，比如 `note.example.com`
- PHP 版本选「纯静态」
- 建完进站点设置 → SSL → Let's Encrypt → 申请 → 开启「强制 HTTPS」

先把域名解析到服务器 IP，再申请证书。

---

## 五、配 Nginx 反向代理 ⚠

**这一步最容易出问题。**

站点设置 → 配置文件，把 `deploy/nginx-cloudnote.conf` 里的内容粘进 `server { }` 里面，保存。

宝塔自带的「反向代理」功能也能用，但它默认不带 WebSocket 的头。**如果只用反向代理面板、没有手动补 `/ws` 那段**，你会看到一个很迷惑的现象：

> 笔记能新建、能保存、刷新也在——**就是多个设备之间不实时同步**。

因为数据走的是 HTTP 接口（正常），实时推送走的是 WebSocket（被 Nginx 挡在门外）。

关键就是这三行：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

配完验证一下：

```bash
curl https://note.example.com/health
# 期望：{"ok":true,"ts":...}
```

---

## 六、放行端口

**不要**在安全组里开放 4471。服务只监听 `127.0.0.1`，外网必须经过 Nginx，这样才走得到 HTTPS。

只需要开 80 和 443（宝塔装好一般已经开了）。

---

## 七、客户端连过来

打开桌面端 → 登录页 → 点「换一个同步服务」→ 填 `https://note.example.com` → 注册账号。

地址存在本地，下次自动用。WebSocket 会自动跟着走 `wss://`，不用单独配。

### 想让客户端装上就默认连你的服务器

打包时注入地址，用户就不用手填了：

```bash
cd app
VITE_CLOUDNOTE_SERVER=https://note.example.com npm run dist
```

装出来的客户端默认连这个地址，登录页仍然可以手动改。

---

---

## 八、（可选）顺手把网页版也部署上

服务端只提供接口，直接打开域名是 404——这是正常的。如果想让浏览器也能用（手机、平板、
别人的电脑不装客户端就能记笔记），把前端静态文件放到网站根目录即可，和桌面端共享同一个
后端，改动实时互通。

**1. 本地构建**（注入你的服务器地址，这样打开网页就能直接登录）

```bash
cd app
VITE_CLOUDNOTE_SERVER=https://note.example.com npm run build
```

产物在 `app/out/renderer/`，一共三个文件、不到 2MB：

```
index.html
assets/index-xxxx.js
assets/index-xxxx.css
```

**2. 上传**到站点根目录 `/www/wwwroot/note.example.com/`（建站时自动创建的那个目录）。

**3. Nginx** 里加上根路径的规则，放在那几段 `^~` 反代**之后**：

```nginx
location / {
    root /www/wwwroot/note.example.com;
    try_files $uri $uri/ /index.html;
}
```

宝塔建站时通常已经有 `root` 指令了，确认一下路径对得上就行。

**4. 打开域名**，应该直接看到笔记界面。

### 网页版和桌面端的区别

功能一致，只有两处按浏览器的能力做了降级：

| | 桌面端 | 网页版 |
|---|---|---|
| 导出 | 弹系统保存对话框，可选目录 | 走浏览器下载 |
| Ctrl+点击链接 | 交给系统默认浏览器 | 开新标签页 |

两边的登录状态是各自独立的，所以会被当成两台设备——正好能验证实时同步。

---

## 日常维护

```bash
pm2 logs cloudnote          # 看日志
pm2 restart cloudnote       # 改完 .env 重启
pm2 monit                   # 看资源占用

cd /www/wwwroot/cloudnote/server
npm run gc                  # 先看报告：有多少软删记录和无人引用的图片可以清
npm run gc -- --apply       # 确认后再清
```

### 备份

要备份的就两样，都在 `server/data/`：

- `cloudnote.db` —— 所有笔记、目录、标签、历史版本
- `uploads/` —— 上传的图片

宝塔 → 计划任务 → 备份目录，指向 `/www/wwwroot/cloudnote/server/data`，设成每天一次。

热备份也可以（SQLite 开了 WAL），但更稳妥的是先停一下：

```bash
pm2 stop cloudnote
tar czf /www/backup/cloudnote-$(date +%F).tar.gz -C /www/wwwroot/cloudnote/server data
pm2 start cloudnote
```

### 升级

```bash
cd /www/wwwroot/cloudnote
git pull                       # 或重新上传 server/
bash deploy/setup.sh           # 会保留现有 .env，只更新依赖并重启
```

数据库结构变更是自动迁移的（启动时按需 `ALTER TABLE`），不会动已有数据。

---

## 出问题了看这里

**服务起不来**

```bash
pm2 logs cloudnote --lines 50
```

常见原因：Node 版本不够（日志里会明说）、端口被占（`lsof -i:4471`）、`.env` 里路径写错。

**能登录，但多端不实时同步**

九成是 Nginx 少了 `/ws` 那段。验证：

```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdA==" \
     https://note.example.com/ws
# 配对了会返回 101 Switching Protocols
# 配错了会看到 400 或 200
```

**图片显示不出来**

检查 `/uploads/` 那段反代在不在，以及 `server/data/uploads` 目录的读权限。

**登录提示「尝试过于频繁」**

限流生效了。它只统计**失败**的登录，成功一次就清零。等 5 分钟，或者调 `.env` 里的
`CLOUDNOTE_AUTH_LIMIT_ID` / `CLOUDNOTE_AUTH_LIMIT_IP` 后重启。

---

## 安全上要知道的几件事

- **密钥**：`setup.sh` 生成的是随机值，别换成好记的字符串。换掉密钥会让所有设备重新登录一次。
- **图片地址不鉴权**：文件名是 32 位随机串，URL 本身就是凭证——这样 `<img>` 才不用带登录头。
  代价是拿到链接的人能看到那张图。介意的话在 Nginx 的 `/uploads/` 段加一层访问控制。
- **注册开放**：任何知道地址的人都能注册。自用的话，建完自己的账号后可以在 Nginx 里封掉注册接口：

  ```nginx
  location = /api/auth/register {
      return 403;
  }
  ```

  这段要放在 `location /api/` **之前**，Nginx 的精确匹配优先级更高。
