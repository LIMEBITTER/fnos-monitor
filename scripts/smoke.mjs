#!/usr/bin/env node
/**
 * 冒烟测试：在临时端口拉起服务端，验证
 *   GET /api/health → 200
 *   GET /api/status → 结构完整（services/overall/calendar/meta）
 *   GET /events     → 首帧是 event: status
 *   GET /           → 返回 index.html
 * 然后关闭进程。不需要浏览器、不依赖构建产物之外的东西。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 18000 + Math.floor(Math.random() * 2000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fnos-monitor-smoke-"));

const child = spawn(process.execPath, [path.join(root, "server", "index.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error(`服务端在 ${timeoutMs}ms 内没有就绪\n${stderr}`);
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  const health = await waitForServer();
  check("GET /api/health", health.ok === true, JSON.stringify(health));
  check("GET /api/health 不暴露版本号", !("version" in health));

  const statusRes = await fetch(`${base}/api/status`);
  check("GET /api/status 状态码", statusRes.status === 200);
  const status = await statusRes.json();
  check("status.services 是数组", Array.isArray(status.services) && status.services.length > 0);
  check("status.calendar 是对象", status.calendar && typeof status.calendar === "object");
  check("status.overall.state 合法", ["up", "degraded", "down", "unknown"].includes(status.overall?.state));
  check(
    "status.meta 字段齐全",
    Boolean(status.meta?.intervalSeconds && status.meta?.historyDays && status.meta?.publicView),
  );
  check("默认公网视图：target 被隐藏", status.services.every((s) => s.target === null));
  check("默认公网视图：输出里没有内网地址", !JSON.stringify(status).includes("127.0.0.1"));
  check("默认公网视图：不暴露版本号", !JSON.stringify(status.meta).includes('"version":"0'));
  const svc = status.services[0];
  check("服务包含 90 天日聚合", Array.isArray(svc?.days) && svc.days.length === status.meta.historyDays);
  check("服务包含 checks 时间线", Array.isArray(svc?.checks));

  const sse = await fetch(`${base}/events`, { signal: AbortSignal.timeout(5000) });
  check("GET /events 状态码", sse.status === 200);
  check("GET /events content-type", (sse.headers.get("content-type") ?? "").includes("text/event-stream"));
  const reader = sse.body.getReader();
  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  check("SSE 首帧是 status 事件", frame.includes("event: status") && frame.includes("data: {"));
  await reader.cancel();

  const home = await fetch(`${base}/`);
  const html = await home.text();
  check("GET / 返回页面", home.status === 200 && html.includes('id="root"'));

  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
} catch (err) {
  failures += 1;
  console.error("冒烟测试异常：", err);
} finally {
  child.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
