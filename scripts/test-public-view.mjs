/**
 * 公网脱敏自测：确保默认视图里没有任何内网地址 / 版本号 / 配置路径。
 * node scripts/test-public-view.mjs
 */
import { publicStatus, redactText } from "../server/public-view.js";

let failed = 0;
function assert(condition, label, extra = "") {
  if (condition) {
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.error(`✗ ${label}${extra ? `：${extra}` : ""}`);
  }
}

assert(redactText("connect ECONNREFUSED 127.0.0.1:3080").includes("[内部地址]"), "IPv4:端口被替换");
assert(!redactText("connect ECONNREFUSED ::1:8793").includes("8793"), "IPv6 端口被替换");
assert(redactText("getaddrinfo ENOTFOUND nas.lan").includes("[内部地址]"), "内网域名被替换");
assert(redactText("https://192.168.31.217:5099/webui/") === "[内部地址]", "URL 被整体替换");
assert(redactText("收到 502") === "收到 502", "普通文本保持不变");
assert(redactText("时间 2026-11-04T00:23:59+08:00").includes("2026-11-04"), "时间戳不被误伤");

const snapshot = {
  site: { name: "fnOS 关键业务", description: "自托管", timezone: "Asia/Shanghai" },
  generatedAt: Date.now(),
  overall: { state: "up", message: "所有系统运行正常", uptime90: 100, downCount: 0, degradedCount: 0, serviceCount: 1 },
  services: [
    {
      id: "dsh-web",
      name: "DeepSeek Harness",
      group: "核心",
      description: "监听 127.0.0.1:3080 的 Web GUI",
      type: "http",
      target: "http://127.0.0.1:3080/",
      state: "down",
      since: Date.now(),
      lastCheckAt: Date.now(),
      latencyMs: 12,
      slowMs: 1200,
      uptime90: 97.5,
      days: [{ date: "2026-11-04", uptime: 97.5, state: "down", total: 10, avgMs: 12 }],
      checks: [{ t: Date.now(), state: "down", ms: 12, code: 502, error: "connect ECONNREFUSED 127.0.0.1:3080" }],
    },
  ],
  incidents: [
    {
      id: "inc-1",
      serviceId: "dsh-web",
      serviceName: "DeepSeek Harness",
      severity: "major",
      state: "open",
      currentState: "down",
      startedAt: Date.now(),
      resolvedAt: null,
      reason: "connect ECONNREFUSED 127.0.0.1:3080",
      updates: [{ at: Date.now(), state: "down", text: "502 来自 192.168.31.217" }],
    },
  ],
  calendar: { "2026-11-04": { up: 0, degraded: 0, down: 10, total: 10, state: "down" } },
  meta: {
    intervalSeconds: 60,
    historyDays: 90,
    version: "0.2.0",
    startedAt: Date.now(),
    configFile: "/app/config/services.json",
    isExample: false,
  },
};

const view = publicStatus(snapshot);
const json = JSON.stringify(view);

assert(view.services[0].target === null, "service.target 被置空");
assert(view.services[0].slowMs === 0, "slowMs 不对外");
assert(view.services[0].checks[0].code === null && view.services[0].checks[0].error === "", "check 的状态码/错误被清空");
assert(!json.includes("127.0.0.1"), "输出里没有 IPv4 地址");
assert(!json.includes("192.168.31.217"), "输出里没有局域网地址");
assert(!json.includes("0.2.0"), "输出里没有版本号");
assert(!json.includes("services.json"), "输出里没有配置文件名");
assert(view.meta.publicView === true, "meta.publicView = true");
assert(view.incidents[0].reason.includes("[内部地址]"), "事故原因被脱敏");
assert(view.incidents[0].updates[0].text.includes("[内部地址]"), "事故更新被脱敏");

console.log(failed ? `\n脱敏自测失败：${failed} 项` : "\n脱敏自测通过");
process.exitCode = failed ? 1 : 0;
