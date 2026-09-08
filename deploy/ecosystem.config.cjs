/**
 * PM2 配置。宝塔的「Node 项目」底层就是 PM2，也可以直接命令行用：
 *
 *   cd /www/wwwroot/cloudnote/server
 *   pm2 start ../deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup     # 开机自启
 *
 * 密钥不要写在这个文件里——它会进版本库。放 server/.env 或系统环境变量。
 */
module.exports = {
  apps: [
    {
      name: 'cloudnote',
      cwd: '/www/wwwroot/cloudnote/server',
      script: 'src/index.js',
      // 单实例：SQLite 是单写入者，多进程会互相锁；
      // 个人/小团队用量下单进程绰绰有余
      instances: 1,
      exec_mode: 'fork',
      node_args: '--no-warnings',
      env: {
        NODE_ENV: 'production',
        PORT: '4471',
        // 只监听回环，外网一律经过 Nginx，避免绕过 HTTPS 直连
        HOST: '127.0.0.1',
      },
      // 崩了自动拉起，但短时间内反复崩就停下，免得刷屏
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      max_memory_restart: '512M',
      error_file: '/www/wwwlogs/cloudnote-error.log',
      out_file: '/www/wwwlogs/cloudnote-out.log',
      time: true,
    },
  ],
}
