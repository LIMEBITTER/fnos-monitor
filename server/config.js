/**
 * 配置加载与归一化。
 *
 * 优先级：环境变量 > config/services.json > config/services.example.json（只读示例）。
 * 真实配置（内网地址、凭据）不提交仓库，迁移时随 data/ 一起拷贝或用环境变量覆盖。
 */
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

const DEFAULTS = {
  checkIntervalSeconds: 60,
  historyDays: 90,
  maxChecks: 360,
  timeoutMs: 5000,
  slowMs: 1200,
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function slug(name, index) {
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `service-${index + 1}`;
}

function parseTarget(service) {
  if (service.type === "tcp") {
    const host = service.host ?? service.target?.split(":")?.[0];
    const port = Number(service.port ?? service.target?.split(":")?.[1]);
    if (!host || !Number.isInteger(port) || port <= 0) {
      throw new Error(`服务 ${service.name ?? service.id} 的 tcp 目标不合法，需要 host + port`);
    }
    return { host, port };
  }
  const url = service.url ?? service.target;
  if (!url) throw new Error(`服务 ${service.name ?? service.id} 缺少 url`);
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`服务 ${service.name ?? service.id} 的 url 只支持 http/https`);
  }
  return { url: parsed.toString() };
}

function normalizeService(service, index) {
  if (!service || typeof service !== "object") throw new Error(`services[${index}] 不是对象`);
  const name = String(service.name ?? "").trim();
  if (!name) throw new Error(`services[${index}] 缺少 name`);

  const type = service.type === "tcp" ? "tcp" : "http";
  const target = parseTarget({ ...service, type });
  const expectStatus = Array.isArray(service.expectStatus)
    ? service.expectStatus.map(Number)
    : type === "http"
      ? null
      : [];

  return {
    id: String(service.id ?? slug(name, index)),
    name,
    group: service.group ? String(service.group) : "",
    description: service.description ? String(service.description) : "",
    type,
    ...target,
    method: String(service.method ?? "GET").toUpperCase(),
    headers: service.headers && typeof service.headers === "object" ? { ...service.headers } : {},
    bodyIncludes: service.bodyIncludes ? String(service.bodyIncludes) : "",
    allowInsecureTls: service.allowInsecureTls === true,
    expectStatus, // null = 任意 2xx/3xx
    timeoutMs: Number(service.timeoutMs ?? DEFAULTS.timeoutMs),
    slowMs: Number(service.slowMs ?? DEFAULTS.slowMs),
    hidden: service.hidden === true,
  };
}

export function loadConfig() {
  const configDir = path.resolve(process.env.CONFIG_DIR ?? path.join(ROOT, "config"));
  const userFile = path.join(configDir, "services.json");
  const exampleFile = path.join(configDir, "services.example.json");
  const file = fs.existsSync(userFile) ? userFile : exampleFile;

  if (!fs.existsSync(file)) {
    throw new Error(`找不到配置：${userFile}（或 ${exampleFile}）`);
  }

  const raw = readJson(file);
  const services = (raw.services ?? []).map(normalizeService);
  if (!services.length) throw new Error(`${file} 里没有任何 service`);

  const seen = new Set();
  for (const s of services) {
    if (seen.has(s.id)) throw new Error(`服务 id 重复：${s.id}`);
    seen.add(s.id);
  }

  return {
    file,
    isExample: file === exampleFile,
    site: {
      name: String(raw.site?.name ?? "fnOS 关键业务"),
      description: String(raw.site?.description ?? "本机部署的关键服务可用性监控"),
      timezone: String(raw.site?.timezone ?? process.env.TZ ?? "Asia/Shanghai"),
    },
    checkIntervalSeconds: Math.max(10, Number(raw.checkIntervalSeconds ?? DEFAULTS.checkIntervalSeconds)),
    historyDays: Math.max(7, Number(raw.historyDays ?? DEFAULTS.historyDays)),
    maxChecks: Math.max(60, Number(raw.maxChecks ?? DEFAULTS.maxChecks)),
    services,
  };
}

export function loadRuntime() {
  return {
    port: Number(process.env.PORT ?? 8787),
    host: String(process.env.HOST ?? "0.0.0.0"),
    dataDir: path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data")),
    distDir: path.join(ROOT, "dist"),
    auth:
      process.env.STATUS_USER && process.env.STATUS_PASSWORD
        ? { user: process.env.STATUS_USER, password: process.env.STATUS_PASSWORD }
        : null,
    dev: process.argv.includes("--dev") || process.env.NODE_ENV === "development",
    version: (() => {
      try {
        return readJson(path.join(ROOT, "package.json")).version ?? "0.0.0";
      } catch {
        return "0.0.0";
      }
    })(),
  };
}
