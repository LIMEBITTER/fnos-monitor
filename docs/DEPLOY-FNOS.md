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
| 访问地址 | `http://192.168.31.217:8787`（局域网） |

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

## 还没做的

- **Lucky 反代**：`status.limebitter.online` / `monitor.limebitter.online` 目前没有 DNS 记录；Lucky 的配置目录 `/vol1/@appdata/Lucky/data` 是 `root` 700，普通用户无法改规则。需要先在 DNS 里加一条指向本机 IPv6（`240e:3a4:4af1:66c0::fcc`）的记录，再在 Lucky 面板加一条 Web 服务规则代理到 `127.0.0.1:8787`，并在 Lucky 里为该域名申请证书。
- 公网暴露前建议在 compose 里设置 `STATUS_USER` / `STATUS_PASSWORD`，或把 `HOST` 改回 `127.0.0.1` 只让反代访问。
