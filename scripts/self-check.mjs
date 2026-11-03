#!/usr/bin/env node
/**
 * 自检：读配置，立即跑一轮探测并打印结果。
 * 用途：部署后确认「配置里的地址从这台机器上真的可达」。
 *
 * 退出码：全部 up/degraded → 0；有 down → 1。
 */
import { loadConfig } from "../server/config.js";
import { runCheck } from "../server/checks.js";

const config = loadConfig();
console.log(`配置：${config.file}${config.isExample ? "（示例配置，建议复制为 services.json）" : ""}`);
console.log(`站点：${config.site.name} · 间隔 ${config.checkIntervalSeconds}s · 历史 ${config.historyDays} 天\n`);

const results = await Promise.all(
  config.services.map(async (service) => ({ service, result: await runCheck(service) })),
);

const label = { up: "正常", degraded: "变慢", down: "不可用" };
let failed = 0;

for (const { service, result } of results) {
  if (result.state === "down") failed += 1;
  const target = service.type === "tcp" ? `${service.host}:${service.port}` : service.url;
  const mark = result.state === "up" ? "✓" : result.state === "degraded" ? "!" : "✗";
  const extra = result.error ? `  ${result.error}` : "";
  console.log(`${mark} ${label[result.state].padEnd(3)} ${String(result.ms).padStart(6)}ms  ${service.name}  ${target}${extra}`);
}

console.log(`\n共 ${results.length} 个服务：${results.filter((r) => r.result.state === "up").length} 正常，${
  results.filter((r) => r.result.state === "degraded").length
} 变慢，${failed} 不可用。`);

process.exit(failed ? 1 : 0);
