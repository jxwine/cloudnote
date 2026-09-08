#!/usr/bin/env bash
# 云笔记服务端一键部署（Ubuntu + 宝塔）
#
#   cd /www/wwwroot/cloudnote
#   bash deploy/setup.sh
#
# 做四件事：查 Node 版本、装依赖、生成密钥、用 PM2 起服务。
# 反复执行是安全的：已有的密钥不会被覆盖。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/server"
ENV_FILE="$SERVER/.env"

say()  { printf '\n\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

say "1/4 检查 Node 版本"
command -v node >/dev/null 2>&1 || die "没找到 node。宝塔面板 → 软件商店 → Node.js 版本管理器，装一个 24.x。"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_FULL="$(node -p 'process.versions.node')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  die "当前 Node $NODE_FULL 太旧。本项目用了 Node 内置的 SQLite，需要 24 或更高。
  宝塔面板 → 软件商店 → Node.js 版本管理器 → 安装 24.x → 设为命令行默认版本。"
fi
ok "Node $NODE_FULL"

say "2/4 安装依赖"
cd "$SERVER"
npm install --omit=dev --no-fund --no-audit
ok "依赖就绪"

say "3/4 准备配置"
if [ -f "$ENV_FILE" ]; then
  ok "已有 .env，保持不变（要换密钥就先删掉它）"
else
  SECRET="$(node -p 'require("crypto").randomBytes(48).toString("base64url")')"
  cat > "$ENV_FILE" <<ENVEOF
# 云笔记服务端配置。这个文件含密钥，别提交到版本库、别对外暴露。
# 改完要重启：pm2 restart cloudnote

# 登录凭证的签名密钥。换掉它 = 让所有设备重新登录一次。
CLOUDNOTE_SECRET=$SECRET

PORT=4471
# 只监听回环，外网统一走 Nginx，免得有人绕过 HTTPS 直连端口
HOST=127.0.0.1

# 数据放哪儿。备份就备份这两个路径。
CLOUDNOTE_DB=$SERVER/data/cloudnote.db
CLOUDNOTE_UPLOADS=$SERVER/data/uploads

# 登录限流：只统计失败，成功一次清零
CLOUDNOTE_AUTH_LIMIT_ID=5
CLOUDNOTE_AUTH_LIMIT_IP=30
ENVEOF
  chmod 600 "$ENV_FILE"
  ok "已生成 .env 和随机密钥（权限 600）"
fi

mkdir -p "$SERVER/data/uploads"
ok "数据目录就绪：$SERVER/data"

say "4/4 启动服务"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "  没装 pm2，正在安装…"
  npm install -g pm2 --no-fund
fi

# PM2 不会自动读 .env，这里显式加载进环境再交给它
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if pm2 describe cloudnote >/dev/null 2>&1; then
  pm2 restart cloudnote --update-env
  ok "已重启"
else
  pm2 start "$SERVER/src/index.js" --name cloudnote \
    --node-args="--no-warnings" --cwd "$SERVER" --time
  ok "已启动"
fi
pm2 save >/dev/null

sleep 2
if curl -fsS "http://127.0.0.1:${PORT:-4471}/health" >/dev/null 2>&1; then
  ok "健康检查通过：http://127.0.0.1:${PORT:-4471}/health"
else
  die "服务没起来。看日志：pm2 logs cloudnote --lines 50"
fi

cat <<TIP

  服务端好了。接下来在宝塔里做两件事：

  1) 建站点并绑定域名，申请 SSL（Let's Encrypt 免费），开「强制 HTTPS」
  2) 把 deploy/nginx-cloudnote.conf 里的内容粘进站点的配置文件

     ⚠ 最容易漏的是 /ws 那段。少了它，笔记能存能读，
       但多端不会实时同步——因为 WebSocket 握手被 Nginx 挡了。

  然后在客户端登录页点「换一个同步服务」，填 https://你的域名

  常用命令：
     pm2 logs cloudnote      看日志
     pm2 restart cloudnote   改完配置重启
     npm run gc              清理软删记录和没人引用的图片（先看报告，加 --apply 才动手）

TIP
