/**
 * 运行时可改的设置：邮件告警、站点信息、探测间隔、管理员账号。
 *
 * 存在 DATA_DIR/settings.json（默认 data/settings.json，不提交仓库），
 * 与 config/services.json 分离：服务清单是部署配置，这里是运维可调的参数。
 *
 * 优先级：settings.json > 环境变量 > 默认值。
 * 管理员：环境变量 STATUS_USER/STATUS_PASSWORD 优先（并会锁住整个站点），
 * 否则用 settings.json 里的 scrypt 哈希；没有任何管理员时，设置页不可用，
 * 需要先跑 `node scripts/set-admin.mjs` 初始化。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILE_VERSION = 1;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function settingsFile(dataDir) {
  return path.join(dataDir, "settings.json");
}

function emptySettings() {
  return { version: FILE_VERSION, sessionSecret: "", admin: null, alerts: {}, site: {}, probe: {} };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/** 读取设置；文件不存在或损坏时返回空设置（不抛错，避免影响监控启动）。 */
export function loadSettings(dataDir) {
  const file = settingsFile(dataDir);
  const raw = readJsonSafe(file);
  const settings = { ...emptySettings(), ...(raw && typeof raw === "object" ? raw : {}) };
  settings.admin = normalizeAdmin(settings.admin);
  settings.alerts = typeof settings.alerts === "object" && settings.alerts ? settings.alerts : {};
  settings.site = typeof settings.site === "object" && settings.site ? settings.site : {};
  settings.probe = typeof settings.probe === "object" && settings.probe ? settings.probe : {};
  if (!settings.sessionSecret) {
    settings.sessionSecret = crypto.randomBytes(32).toString("hex");
    settings.dirty = true;
  }
  settings.file = file;
  return settings;
}

function normalizeAdmin(admin) {
  if (!admin || typeof admin !== "object") return null;
  const { user, salt, hash } = admin;
  if (typeof user !== "string" || !user || typeof salt !== "string" || typeof hash !== "string") return null;
  return { user, salt, hash };
}

/** 原子写入（tmp + rename），权限 600：里面有 SMTP 授权码与会话密钥。 */
export function saveSettings(settings) {
  const file = settings.file ?? settingsFile(process.env.DATA_DIR ?? "data");
  const payload = {
    version: FILE_VERSION,
    sessionSecret: settings.sessionSecret,
    admin: settings.admin,
    alerts: settings.alerts,
    site: settings.site,
    probe: settings.probe,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 某些文件系统（如 Windows 挂载）不支持 chmod，忽略 */
  }
  settings.dirty = false;
}

/** scrypt 哈希，返回 { salt, hash }；哈希与盐都是 base64。 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

export function verifyPassword(password, admin) {
  if (!admin || typeof password !== "string") return false;
  let expected;
  try {
    expected = Buffer.from(admin.hash, "base64");
  } catch {
    return false;
  }
  const actual = crypto.scryptSync(password, Buffer.from(admin.salt, "base64"), expected.length, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function createAdmin(user, password) {
  const name = String(user ?? "").trim() || "admin";
  const { salt, hash } = hashPassword(String(password));
  return { user: name, salt, hash };
}

export function issueSession(settings, user, now = Date.now()) {
  const expires = now + SESSION_TTL_MS;
  const signature = crypto
    .createHmac("sha256", settings.sessionSecret)
    .update(`${user}.${expires}`)
    .digest("base64url");
  return { token: `${Buffer.from(user, "utf8").toString("base64url")}.${expires}.${signature}`, expires };
}

/** 返回用户名或 null；签名不对、过期、格式错误都算未登录。 */
export function verifySession(settings, token, now = Date.now()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedUser, rawExpires, signature] = parts;
  const expires = Number(rawExpires);
  if (!Number.isFinite(expires) || expires < now) return null;

  let user;
  try {
    user = Buffer.from(encodedUser, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = crypto
    .createHmac("sha256", settings.sessionSecret)
    .update(`${user}.${expires}`)
    .digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? user : null;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function parseRecipients(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[,;\s]+/);
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

/**
 * 校验并归一化设置补丁；只接受已知字段，非法时抛带中文消息的 Error。
 * alerts.pass 留空表示「保持原密码」，clearPass=true 才清空。
 */
export function validatePatch(patch, current = {}) {
  if (!patch || typeof patch !== "object") throw new Error("请求体必须是对象");
  const next = {};

  if (patch.alerts !== undefined) {
    const input = patch.alerts ?? {};
    if (typeof input !== "object") throw new Error("alerts 必须是对象");
    const alerts = { ...(current.alerts ?? {}) };

    const text = (key, label, max) => {
      if (input[key] === undefined) return;
      const value = String(input[key] ?? "").trim();
      if (value.length > max) throw new Error(`${label}太长（最多 ${max} 个字符）`);
      alerts[key] = value;
    };

    text("host", "SMTP 服务器", 255);
    text("user", "SMTP 用户名", 200);
    text("from", "发件人", 200);
    text("url", "状态页地址", 500);

    if (input.port !== undefined) alerts.port = clampInt(input.port, 1, 65535, 465);
    if (input.secure !== undefined) alerts.secure = Boolean(input.secure);
    if (input.repeatMinutes !== undefined) alerts.repeatMinutes = clampInt(input.repeatMinutes, 0, 10080, 0);

    if (input.pass !== undefined && String(input.pass).length > 0) {
      if (String(input.pass).length > 200) throw new Error("SMTP 密码太长");
      alerts.pass = String(input.pass);
    } else if (input.clearPass === true) {
      alerts.pass = "";
    }

    if (input.to !== undefined) {
      const recipients = parseRecipients(input.to);
      if (recipients.length > 10) throw new Error("收件人最多 10 个");
      for (const address of recipients) {
        if (!EMAIL_RE.test(address)) throw new Error(`收件人不是合法邮箱：${address}`);
      }
      alerts.to = recipients;
    }

    if (alerts.from && !EMAIL_RE.test(alerts.from.replace(/^.*<([^>]+)>$/, "$1"))) {
      throw new Error("发件人需要是邮箱地址，或 `显示名 <邮箱>`");
    }
    if (alerts.url && !/^https?:\/\/\S+$/i.test(alerts.url)) {
      throw new Error("状态页地址需要以 http:// 或 https:// 开头");
    }
    if (alerts.host && !/^[a-zA-Z0-9.\-_\[\]:]+$/.test(alerts.host)) {
      throw new Error("SMTP 服务器地址不合法");
    }
    next.alerts = alerts;
  }

  if (patch.site !== undefined) {
    const input = patch.site ?? {};
    if (typeof input !== "object") throw new Error("site 必须是对象");
    const site = { ...(current.site ?? {}) };
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 60) throw new Error("站点名称需要 1–60 个字符");
      site.name = name;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 200) throw new Error("站点描述最多 200 个字符");
      site.description = description;
    }
    next.site = site;
  }

  if (patch.probe !== undefined) {
    const input = patch.probe ?? {};
    if (typeof input !== "object") throw new Error("probe 必须是对象");
    next.probe = {
      ...(current.probe ?? {}),
      checkIntervalSeconds: clampInt(
        input.checkIntervalSeconds ?? current.probe?.checkIntervalSeconds,
        10,
        3600,
        60,
      ),
    };
  }

  return next;
}

/** 把设置里的站点信息与探测间隔落到 config 上（进程内生效）。 */
export function applyToConfig(settings, config) {
  if (settings.site?.name) config.site.name = String(settings.site.name);
  if (settings.site?.description !== undefined) {
    config.site.description = String(settings.site.description);
  }
  const interval = Number(settings.probe?.checkIntervalSeconds);
  if (Number.isFinite(interval)) config.checkIntervalSeconds = clampInt(interval, 10, 3600, 60);
  return config;
}

/** 对外展示的设置（密码只回 hasPass，不回明文）。 */
export function publicSettings(settings, { adminSource = "file" } = {}) {
  const alerts = settings.alerts ?? {};
  return {
    admin: settings.admin ? { user: settings.admin.user, source: adminSource } : null,
    alerts: {
      host: alerts.host ?? "",
      port: alerts.port ?? 465,
      secure: alerts.secure ?? true,
      user: alerts.user ?? "",
      hasPass: Boolean(alerts.pass),
      from: alerts.from ?? "",
      to: Array.isArray(alerts.to) ? alerts.to : [],
      repeatMinutes: alerts.repeatMinutes ?? 0,
      url: alerts.url ?? "",
    },
    site: settings.site ?? {},
    probe: settings.probe ?? {},
  };
}
