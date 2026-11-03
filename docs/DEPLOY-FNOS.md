# fnOS 实机部署记录

这份文档记录 fnos-monitor 在飞牛 OS（fnOS）上的实际部署方式与踩过的坑，供同一台或同类机器复现时参考。通用部署方式见 README 的「部署」一节。

## 环境

| 项目 | 值 |
| --- | --- |
| 主机 | 192.168.31.217（`CouldBeNAS`），内核 6.18（fnOS） |
| Node | v24.22.1（`/usr/local/bin/node`） |
| Docker | 28.5.2，Compose v2.40.3 |
| 权限 | 普通用户 `baiyu` 在 `docker` 组，`sudo` 需要密码 |
| 代码目录 | `/home/baiyu/apps/fnos-monitor`（`git clone` 的仓库） |
| 数据目录 | `./data/state.json`（挂载进容器 `/data`） |
| 访问地址 | `http://192.168.31.217:8787`（局域网）、`https://status.limebitter.online:57921`（公网，仅 IPv6） |

因为拿不到 root，没有用 `deploy/fnos-monitor.service`，而是用 Docker Compose 跑，`restart: unless-stopped` 负责开机自启。

## 部署步骤

```bash
git clone https://github.com/LIMEBITTER/fnos-monitor.git ~/apps/fnos-monitor
cd ~/apps/fnos-monitor
cp config/services.example.json config/services.json
# 按下面的「配置差异」改 services.json
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8787/api/health
```

`docker-compose.yml` 已经用 `network_mode: host`，并把 `HOST` 设为 `0.0.0.0`，局域网可直接访问。

## 配置差异

`config/services.json` 不进仓库，这台机器上相对示例改了三处：

| 服务 | 值 | 原因 |
| --- | --- | --- |
| `snowluma` | `http://192.168.31.217:5099/` | 容器端口发布绑定在局域网 IP，`127.0.0.1:5099` 不通 |
| `novnc` | `http://192.168.31.217:6081/` | 同上 |
| `lucky-tls` | `"host": "::1", "port": 57921` | Lucky TLS 入口只监听 `[::]:57921`，IPv4 回环被拒 |

其余服务（DSH 3080、OneBot 3000/3001、mihomo 9090、Lucky 面板 16601）都监听 `127.0.0.1`，在 host 网络下直接可用。

## 构建时踩的坑

1. **镜像拉取 401**：`docker compose build` 解析 `node:22-alpine` 时，`docker.fnnas.com` 镜像加速返回 `401 Unauthorized`。绕法是先从可用的镜像站拉下来再打 tag：

   ```bash
   docker pull docker.m.daocloud.io/library/node:22-alpine
   docker tag docker.m.daocloud.io/library/node:22-alpine node:22-alpine
   docker compose build
   ```

2. **pnpm 构建脚本被忽略**：`RUN pnpm install --frozen-lockfile` 以 `ERR_PNPM_IGNORED_BUILDS: esbuild@0.25.12` 退出 1，因为 Dockerfile 最初只拷了 `package.json` 和 lockfile，没拷 `pnpm-workspace.yaml`（`allowBuilds` 在那里）。已在 `68180a2` 修复。

3. **桥接网络探不到回环服务**：容器里 `127.0.0.1` 是容器自己，8 个服务全部误判 down。已在 `a4c201f` 改成 `network_mode: host`。

## 更新

```bash
cd ~/apps/fnos-monitor
git pull
docker compose up -d --build
```

`data/` 是 bind mount，重建容器不会丢历史。

## Lucky 反向代理（公网访问）

面板 `http://192.168.31.217:16601/luckyeric/`（Lucky 3.5.0），主规则 `nas :57921` 已经是 IPv6 + HTTPS。在这条规则下新增子规则：

| 字段 | 值 |
| --- | --- |
| 子规则名称 | `status` |
| 前端地址 | `status.limebitter.online` |
| 后端地址 | `http://127.0.0.1:8787` |

证书复用主规则的 `*.limebitter.online`（ZeroSSL，2026-10-08 至 2027-01-06），新子域不需要重新申请。

DNS 由 Lucky「动态域名」里的腾讯云任务维护：在该任务下新增一条 AAAA，记录名 `status.limebitter.online`、值 `240e:3a4:4af1:66c0::fcc`、备注 `status`，Lucky 会按任务里的 IPv6 来源（HTTP/STUN/DNS）自动同步。

验证时可以在 NAS 上绕过公网 DNS 直连本机：

```bash
curl -sk --resolve 'status.limebitter.online:57921:[::1]' \
  https://status.limebitter.online:57921/api/health
curl -sk --resolve 'status.limebitter.online:57921:[::1]' \
  -o /dev/null -w '%{http_code}\n' https://status.limebitter.online:57921/
```

外网访问注意：

- 这台机器只有 IPv6 公网地址，`status.limebitter.online` 也只解析出 AAAA；纯 IPv4 网络打不开，与 `dsh.limebitter.online` 的情况一致。
- 页面默认走公网视图：探测目标、状态码、错误详情、版本号都不下发，事故原因里的内网地址替换为 `[内部地址]`。本机排障想看完整信息时，在 compose 里设 `EXPOSE_INTERNAL=true`；或者启用 `STATUS_USER` / `STATUS_PASSWORD`，登录后自动看到完整视图。

## 邮件告警与网页设置

推荐在网页里配置，改完立即生效，不用重启容器。先初始化管理员（只需一次）：

```bash
docker compose exec fnos-monitor node scripts/set-admin.mjs
```

命令会打印用户名与随机密码；打开状态页右上角的齿轮（或 `https://status.limebitter.online:57921/settings`），登录后填 SMTP 服务器、端口、授权码、收件人，点「发送测试邮件」确认能收到，再保存。设置写入 `data/settings.json`，**优先于 `.env` 里的 `ALERT_*`**；备份 `data/` 时记得把它一起带走（里面还有管理员密码哈希）。

也可以继续用环境变量（适合用配置管理工具批量部署）。在仓库目录新建 `.env`（已 gitignore），填 SMTP 信息后重建容器：

```bash
cd ~/apps/fnos-monitor
cat > .env <<'EOF'
ALERT_SMTP_HOST=smtp.qq.com
ALERT_SMTP_PORT=465
ALERT_SMTP_SECURE=true
ALERT_SMTP_USER=you@qq.com
ALERT_SMTP_PASS=授权码
ALERT_FROM=you@qq.com
ALERT_TO=you@qq.com
ALERT_REPEAT_MINUTES=180
ALERT_URL=https://status.limebitter.online:57921
EOF
docker compose up -d
docker compose logs --tail=20 fnos-monitor | grep alert
```

启动日志里出现 `邮件通知已启用：smtp.qq.com:465 → …` 就说明读到了配置；服务异常时日志会打印 `[alert] 已发送邮件：[异常] …`。

`docker-compose.yml` 里的 `env_file` 用了 `required: false`，所以没有 `.env` 也能正常启动，只是不会发信。

## 还没做的

- 多探针聚合（FM-006）、历史导出（FM-007）、Webhook / 静默期（FM-009），见 `docs/ISSUES.md`。
