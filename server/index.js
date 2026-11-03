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
 *           EXPOSE_INTERNAL=true  公网视图下也返回内部地址（默认关闭）
 *           ALERT_*               SMTP 邮件通知，见 server/alerts.js
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAlerter } from "./alerts.js";
import { loadConfig, loadRuntime } from "./config.js";
import { publicStatus } from "./public-view.js";
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
const alerter = createAlerter({ siteName: config.site.name, timezone: config.site.timezone });

function isAuthed(req) {
  if (!runtime.auth) return false;
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const [user, ...rest] = Buffer.from(encoded, "base64").toString("utf8").split(":");
  return safeEqual(user, runtime.auth.user) && safeEqual(rest.join(":"), runtime.auth.password);
}

/** 公网默认脱敏：内部地址、错误详情、版本号只对登录用户或 EXPOSE_INTERNAL 可见。 */
function wantsFullView(req) {
  return runtime.exposeInternal || isAuthed(req);
}

function statusPayload(req) {
  const status = store.buildStatus(config, runtime);
  return wantsFullView(req) ? status : publicStatus(status);
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
  if (isAuthed(req)) return true;
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
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload(req))}\n\n`);
  const client = { res, full: wantsFullView(req) };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
}

function broadcast() {
  if (!sseClients.size) return;
  const status = store.buildStatus(config, runtime);
  let fullFrame = null;
  let publicFrame = null;
  for (const client of sseClients) {
    let frame;
    if (client.full) {
      fullFrame ??= `event: status\ndata: ${JSON.stringify(status)}\n\n`;
      frame = fullFrame;
    } else {
      publicFrame ??= `event: status\ndata: ${JSON.stringify(publicStatus(status))}\n\n`;
      frame = publicFrame;
    }
    try {
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

const scheduler = createScheduler({
  config,
  store,
  notify: (event) => alerter.notify(event),
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
    });
  }

  if (!checkAuth(req, res)) return;

  if (url.pathname === "/api/status") {
    return sendJson(res, 200, statusPayload(req));
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
  console.log(
    runtime.exposeInternal
      ? "  视图：完整（EXPOSE_INTERNAL=true，内网地址对所有人可见）"
      : "  视图：公网脱敏（隐藏探测目标与错误详情；登录用户或 EXPOSE_INTERNAL=true 可见完整信息）",
  );
  if (runtime.auth) console.log("  已启用 Basic Auth");
  console.log(`  ${alerter.describe()}`);
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
  for (const client of sseClients) client.res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

scheduler.start().catch((err) => {
  console.error("首轮检查失败：", err);
});
