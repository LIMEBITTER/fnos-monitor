/**
 * HTTP 服务：静态站点 + JSON API + SSE 推送。
 *
 * 路由：
 *   GET /                 → dist/index.html
 *   GET /assets/*         → 构建产物
 *   GET /api/status       → 当前状态快照（前端首屏 + 轮询兜底）
 *   GET /api/health       → 监控自身的健康检查
 *   GET /events           → SSE，每次采集完成后推送一份新的 status
 *
 * 环境变量：PORT / HOST / DATA_DIR / CONFIG_DIR / STATUS_USER / STATUS_PASSWORD / TZ
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig, loadRuntime } from "./config.js";
import { createScheduler } from "./scheduler.js";
import { Store } from "./store.js";

const runtime = loadRuntime();
const config = loadConfig();
const store = new Store({
  file: path.join(runtime.dataDir, "state.json"),
  historyDays: config.historyDays,
  maxChecks: config.maxChecks,
}).load();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const sseClients = new Set();

function statusPayload() {
  return store.buildStatus(config, runtime);
}

function sendJson(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function checkAuth(req, res) {
  if (!runtime.auth) return true;
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, ...rest] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    const password = rest.join(":");
    const okUser = safeEqual(user, runtime.auth.user);
    const okPass = safeEqual(password, runtime.auth.password);
    if (okUser && okPass) return true;
  }
  res.writeHead(401, { "www-authenticate": 'Basic realm="fnos-monitor", charset="UTF-8"' });
  res.end("需要登录");
  return false;
}

function safeEqual(a = "", b = "") {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function serveStatic(req, res, pathname) {
  const distDir = runtime.distDir;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(distDir, rel);
  if (!file.startsWith(path.resolve(distDir))) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      // 前端是单页应用：未知路径回 index.html
      fs.readFile(path.join(distDir, "index.html"), (e2, html) => {
        if (e2) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("还没有构建产物：先跑 npm run build（开发时用 npm run dev）");
          return;
        }
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
        res.end(html);
      });
      return;
    }

    const ext = path.extname(file);
    const immutable = rel.startsWith("assets/");
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
      "content-length": stat.size,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function handleSse(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 5000\n\n");
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

function broadcast() {
  if (!sseClients.size) return;
  const payload = statusPayload();
  const frame = `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

const scheduler = createScheduler({
  config,
  store,
  onUpdate: (summary) => {
    broadcast();
    if (runtime.dev) {
      console.log(
        `[tick] up=${summary.up} degraded=${summary.degraded} down=${summary.down} (${summary.durationMs}ms)`,
      );
    }
  },
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // 健康检查不鉴权：容器 healthcheck / 外部看门狗不该依赖凭据，且这里不暴露任何目标信息。
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      services: config.services.length,
      lastRunAt: scheduler.lastRunAt(),
      version: runtime.version,
    });
  }

  if (!checkAuth(req, res)) return;

  if (url.pathname === "/api/status") {
    return sendJson(res, 200, statusPayload());
  }

  if (url.pathname === "/events") {
    return handleSse(req, res);
  }

  if (url.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { ok: false, error: "not found" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(runtime.port, runtime.host, () => {
  const where = runtime.host === "0.0.0.0" ? "所有网卡" : runtime.host;
  console.log(`fnos-monitor v${runtime.version} 已启动：http://${runtime.host}:${runtime.port}`);
  console.log(`  监听：${where}｜配置：${config.file}${config.isExample ? "（示例配置，改 config/services.json）" : ""}`);
  console.log(`  数据：${path.join(runtime.dataDir, "state.json")}｜间隔：${config.checkIntervalSeconds}s｜历史：${config.historyDays} 天`);
  if (runtime.auth) console.log("  已启用 Basic Auth");
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，保存状态并退出…`);
  scheduler.stop();
  try {
    store.save();
  } catch (err) {
    console.error("保存失败：", err);
  }
  for (const res of sseClients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

scheduler.start().catch((err) => {
  console.error("首轮检查失败：", err);
});
