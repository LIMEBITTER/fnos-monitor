/**
 * HTTP 服务：静态站点 + JSON API + SSE 推送。
 *
 * 路由：
 *   GET  /                      → dist/index.html（单页应用）
 *   GET  /api/status            → 当前状态快照（前端首屏 + 轮询兜底）
 *   GET  /api/health            → 监控自身的健康检查（不鉴权）
 *   GET  /events                → SSE，每次采集完成后推送一份新的 status
 *   GET  /api/session           → 当前登录状态
 *   POST /api/login             → 管理员登录（会话 cookie）
 *   POST /api/logout            → 退出登录
 *   GET  /api/settings          → 读取运行时设置（需管理员）
 *   PUT  /api/settings          → 保存运行时设置（需管理员）
 *   POST /api/settings/test-mail→ 用当前设置发一封测试邮件（需管理员）
 *   POST /api/password          → 修改管理员密码（需管理员）
 *
 * 环境变量：PORT / HOST / DATA_DIR / CONFIG_DIR / STATUS_USER / STATUS_PASSWORD / TZ
 *           EXPOSE_INTERNAL=true  公网视图下也返回内部地址（默认关闭）
 *           ALERT_*               SMTP 邮件通知默认值，设置页保存后以 data/settings.json 为准
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAlerter, readAlertSettings, sendTestMail } from "./alerts.js";
import { loadConfig, loadRuntime } from "./config.js";
import { publicStatus } from "./public-view.js";
import { createScheduler } from "./scheduler.js";
import {
  applyToConfig,
  createAdmin,
  loadSettings,
  saveSettings,
  validatePatch,
  verifyPassword,
  verifySession,
  issueSession,
} from "./settings.js";
import { Store } from "./store.js";

const runtime = loadRuntime();
const config = loadConfig();
let settings = loadSettings(runtime.dataDir);
applyToConfig(settings, config);
if (settings.dirty) {
  try {
    saveSettings(settings);
  } catch (err) {
    console.warn(`[settings] 无法写入 ${settings.file}：${err.message}`);
  }
}

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

const SESSION_COOKIE = "fm_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const sseClients = new Set();
let alerter = createAlerter({
  siteName: config.site.name,
  timezone: config.site.timezone,
  overrides: settings.alerts,
});

let settingsMtime = 0;
try {
  settingsMtime = fs.statSync(settings.file).mtimeMs;
} catch {
  /* settings.json 尚未生成 */
}

/**
 * 设置文件被外部改动（例如在容器里跑 set-admin）后热加载一次，
 * 免得初始化完管理员还要手动重启服务。
 */
function syncSettingsFromDisk() {
  let mtime;
  try {
    mtime = fs.statSync(settings.file).mtimeMs;
  } catch {
    return;
  }
  if (mtime === settingsMtime) return;
  settingsMtime = mtime;
  try {
    const fresh = loadSettings(runtime.dataDir);
    fresh.sessionSecret ||= settings.sessionSecret;
    settings = fresh;
    applyToConfig(settings, config);
    alerter = createAlerter({
      siteName: config.site.name,
      timezone: config.site.timezone,
      overrides: settings.alerts,
    });
    scheduler.setIntervalSeconds(config.checkIntervalSeconds);
    console.log("[settings] 检测到 settings.json 变化，已重新加载");
  } catch (err) {
    console.warn(`[settings] 重新加载失败：${err.message}`);
  }
}

function safeEqual(a = "", b = "") {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isAuthed(req) {
  if (!runtime.auth) return false;
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const [user, ...rest] = Buffer.from(encoded, "base64").toString("utf8").split(":");
  return safeEqual(user, runtime.auth.user) && safeEqual(rest.join(":"), runtime.auth.password);
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return verifySession(settings, token);
}

/** 管理员来源：环境变量 Basic Auth 优先，其次是 data/settings.json 里的账号。 */
function adminSource() {
  if (runtime.auth) return "env";
  return settings.admin ? "file" : null;
}

function isAdmin(req) {
  return isAuthed(req) || Boolean(sessionUser(req));
}

/** 公网默认脱敏：内部地址、错误详情、版本号只对管理员或 EXPOSE_INTERNAL 可见。 */
function wantsFullView(req) {
  return runtime.exposeInternal || isAdmin(req);
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

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体太大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求体不是合法 JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** 写操作要求 JSON Content-Type；带 Origin 时必须是同源，挡掉表单 CSRF。 */
function checkWriteRequest(req, res) {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.includes("application/json")) {
    sendJson(res, 415, { ok: false, error: "请求需要 application/json" });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = "";
    }
    if (originHost && originHost !== req.headers.host) {
      sendJson(res, 403, { ok: false, error: "跨站请求被拒绝" });
      return false;
    }
  }
  return true;
}

function requireAdmin(req, res) {
  if (!adminSource()) {
    sendJson(res, 409, {
      ok: false,
      error: "还没有管理员账号。在服务器上运行 node scripts/set-admin.mjs 初始化后再刷新。",
      needsAdmin: true,
    });
    return false;
  }
  if (!isAdmin(req)) {
    sendJson(res, 401, { ok: false, error: "需要登录" });
    return false;
  }
  return true;
}

function setSessionCookie(res, user) {
  const { token } = issueSession(settings, user);
  res.setHeader(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`,
  );
}

/** 把表单需要的当前值拼出来：settings.json 优先，缺项回落到环境变量。 */
function alertsForForm() {
  const current = settings.alerts ?? {};
  const env = process.env;
  const pick = (value, fallback) => (value !== undefined && value !== "" ? value : fallback);
  return {
    host: pick(current.host, env.ALERT_SMTP_HOST ?? ""),
    port: Number(pick(current.port, env.ALERT_SMTP_PORT ?? 465)),
    secure:
      typeof current.secure === "boolean"
        ? current.secure
        : env.ALERT_SMTP_SECURE
          ? /^(1|true|yes|on)$/i.test(env.ALERT_SMTP_SECURE)
          : Number(pick(current.port, env.ALERT_SMTP_PORT ?? 465)) === 465,
    user: pick(current.user, env.ALERT_SMTP_USER ?? ""),
    hasPass: Boolean(pick(current.pass, env.ALERT_SMTP_PASS ?? "")),
    from: pick(current.from, env.ALERT_FROM ?? ""),
    to: Array.isArray(current.to) && current.to.length
      ? current.to
      : String(env.ALERT_TO ?? "")
          .split(/[,;\s]+/)
          .filter(Boolean),
    repeatMinutes: Number(pick(current.repeatMinutes, env.ALERT_REPEAT_MINUTES ?? 0)),
    url: pick(current.url, env.ALERT_URL ?? ""),
  };
}

function settingsPayload() {
  return {
    ok: true,
    admin: adminSource() === "env" ? { user: runtime.auth.user, source: "env" } : { user: settings.admin.user, source: "file" },
    alerts: alertsForForm(),
    site: { name: config.site.name, description: config.site.description },
    probe: { checkIntervalSeconds: config.checkIntervalSeconds },
    envManaged: {
      auth: Boolean(runtime.auth),
      smtp: Boolean(process.env.ALERT_SMTP_HOST || process.env.ALERT_TO),
    },
  };
}

function applySettingsPatch(patch) {
  Object.assign(settings, patch);
  saveSettings(settings);
  try {
    settingsMtime = fs.statSync(settings.file).mtimeMs;
  } catch {
    /* 忽略：下一次请求会按新 mtime 处理 */
  }
  applyToConfig(settings, config);
  scheduler.setIntervalSeconds(config.checkIntervalSeconds);
  alerter = createAlerter({
    siteName: config.site.name,
    timezone: config.site.timezone,
    overrides: settings.alerts,
  });
  broadcast();
}

const loginAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.first > 10 * 60 * 1000) {
    loginAttempts.set(ip, { first: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}

async function handleApi(req, res, url) {
  syncSettingsFromDisk();
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/api/session") {
    const user = sessionUser(req);
    return sendJson(res, 200, {
      ok: true,
      authenticated: Boolean(user) || isAuthed(req),
      user: user ?? (isAuthed(req) ? runtime.auth.user : null),
      source: adminSource(),
      canManage: Boolean(adminSource()),
    });
  }

  if (pathname === "/api/login" && method === "POST") {
    if (!checkWriteRequest(req, res)) return;
    const ip = req.socket.remoteAddress ?? "unknown";
    if (rateLimited(ip)) {
      return sendJson(res, 429, { ok: false, error: "尝试次数过多，请 10 分钟后再试" });
    }
    const body = await readJsonBody(req);
    const user = String(body.user ?? "").trim();
    const password = String(body.password ?? "");
    if (!adminSource()) {
      return sendJson(res, 409, {
        ok: false,
        error: "还没有管理员账号。在服务器上运行 node scripts/set-admin.mjs 初始化。",
        needsAdmin: true,
      });
    }
    const valid = runtime.auth
      ? safeEqual(user, runtime.auth.user) && safeEqual(password, runtime.auth.password)
      : safeEqual(user, settings.admin.user) && verifyPassword(password, settings.admin);
    if (!valid) {
      return sendJson(res, 401, { ok: false, error: "用户名或密码不正确" });
    }
    loginAttempts.delete(ip);
    setSessionCookie(res, runtime.auth ? runtime.auth.user : settings.admin.user);
    return sendJson(res, 200, { ok: true, user: runtime.auth ? runtime.auth.user : settings.admin.user });
  }

  if (pathname === "/api/logout" && method === "POST") {
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/settings" && method === "GET") {
    if (!requireAdmin(req, res)) return;
    return sendJson(res, 200, settingsPayload());
  }

  if (pathname === "/api/settings" && method === "PUT") {
    if (!requireAdmin(req, res)) return;
    if (!checkWriteRequest(req, res)) return;
    const body = await readJsonBody(req);
    const patch = validatePatch(body, settings);
    applySettingsPatch(patch);
    return sendJson(res, 200, settingsPayload());
  }

  if (pathname === "/api/settings/test-mail" && method === "POST") {
    if (!requireAdmin(req, res)) return;
    if (!checkWriteRequest(req, res)) return;
    const resolved = readAlertSettings(config.site.timezone, settings.alerts);
    if (!resolved) {
      return sendJson(res, 400, { ok: false, error: "邮件通知未启用：先填 SMTP 服务器与收件人并保存" });
    }
    try {
      await sendTestMail(resolved, config.site.name);
      return sendJson(res, 200, { ok: true, to: resolved.recipients });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: `发送失败：${err.message}` });
    }
  }

  if (pathname === "/api/password" && method === "POST") {
    if (!requireAdmin(req, res)) return;
    if (!checkWriteRequest(req, res)) return;
    if (adminSource() === "env") {
      return sendJson(res, 409, {
        ok: false,
        error: "密码由 STATUS_PASSWORD 环境变量提供，请修改该变量后重启服务。",
      });
    }
    const body = await readJsonBody(req);
    const current = String(body.currentPassword ?? "");
    const next = String(body.newPassword ?? "");
    if (!verifyPassword(current, settings.admin)) {
      return sendJson(res, 401, { ok: false, error: "当前密码不正确" });
    }
    if (next.length < 8) {
      return sendJson(res, 400, { ok: false, error: "新密码至少 8 位" });
    }
    settings.admin = createAdmin(settings.admin.user, next);
    saveSettings(settings);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: "not found" });
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

  try {
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
      return await handleApi(req, res, url);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err?.status ?? 500;
    if (status >= 500) console.error("[http] 请求失败：", err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err?.message ?? "服务器内部错误" });
    else res.end();
  }
});

server.listen(runtime.port, runtime.host, () => {
  const where = runtime.host === "0.0.0.0" ? "所有网卡" : runtime.host;
  console.log(`fnos-monitor v${runtime.version} 已启动：http://${runtime.host}:${runtime.port}`);
  console.log(`  监听：${where}｜配置：${config.file}${config.isExample ? "（示例配置，改 config/services.json）" : ""}`);
  console.log(`  数据：${path.join(runtime.dataDir, "state.json")}｜间隔：${config.checkIntervalSeconds}s｜历史：${config.historyDays} 天`);
  console.log(
    runtime.exposeInternal
      ? "  视图：完整（EXPOSE_INTERNAL=true，内网地址对所有人可见）"
      : "  视图：公网脱敏（隐藏探测目标与错误详情；登录管理员或 EXPOSE_INTERNAL=true 可见完整信息）",
  );
  if (runtime.auth) console.log("  已启用 Basic Auth");
  console.log(
    adminSource() === "env"
      ? "  管理：使用 STATUS_USER / STATUS_PASSWORD（环境变量）"
      : adminSource() === "file"
        ? `  管理：${settings.admin.user}（页面 /settings 可改设置）`
        : "  管理：尚未初始化，运行 node scripts/set-admin.mjs 创建管理员后可在页面改设置",
  );
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
