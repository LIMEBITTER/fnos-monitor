# 问题台账

GitHub Issues 尚未启用，问题先在这里编号管理。提交信息引用 `FM-xxx`，格式见 README「问题与提交」。

状态：`open` 待处理 / `doing` 进行中 / `done` 已完成。

| 编号 | 标题 | 状态 | 说明 |
| --- | --- | --- | --- |
| FM-001 | 采集服务、配置加载与状态持久化 | done | `server/` 下的探针、调度、JSON 存储与原子写；`config/services.example.json` 作为模板 |
| FM-002 | 状态页前端：深色模式、动画、响应式 | done | Vite + React + TS；SSE 实时更新、90 天柱状图、日历、事故时间线、深浅色切换 |
| FM-003 | 部署与迁移：Docker、systemd、README | done | Dockerfile / compose / systemd unit / 迁移清单；README 覆盖配置、API、设计取舍 |
| FM-004 | 自检、冒烟与 CI | done | `scripts/self-check.mjs`、`scripts/smoke.mjs`、GitHub Actions 构建 + 冒烟 |
| FM-005 | 事故通知渠道 | open | 支持 Webhook / 邮件 / 推送，事故开启与恢复时各发一次；需要去重与静默期，避免抖动刷屏 |
| FM-006 | 多探针聚合 | open | 允许从外部探针上报结果，服务端合并为「多地点可用性」；需要定义上报鉴权与冲突合并规则 |
| FM-007 | 历史数据导出 | open | 导出 CSV / Prometheus 指标，便于接 Grafana；当前只有按日聚合，导出前需确认精度足够 |

## 约定

- 新问题先加一行，编号顺延，不回收。
- 修复提交写 `fix(scope): 描述 (FM-00X)`，功能提交写 `feat(scope): 描述 (FM-00X)`。
- 一个提交尽量只对应一个问题；跨问题的改动在提交信息里列全编号。
