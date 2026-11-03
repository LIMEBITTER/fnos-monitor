/**
 * 邮件通知：服务开事故 / 恢复 / 长时间未恢复时发一封信。
 *
 * 全部通过环境变量配置，凭据不进仓库：
 *   ALERT_SMTP_HOST       smtp.qq.com
 *   ALERT_SMTP_PORT       465（465 配 ALERT_SMTP_SECURE=true；587 用 STARTTLS）
 *   ALERT_SMTP_SECURE     true / false
 *   ALERT_SMTP_USER       登录用户名（通常是邮箱地址）
 *   ALERT_SMTP_PASS       授权码 / 应用专用密码，不是邮箱登录密码
 *   ALERT_FROM            发件人，缺省用 ALERT_SMTP_USER
 *   ALERT_TO              收件人，多个用逗号分隔
 *   ALERT_REPEAT_MINUTES  持续异常时每隔多少分钟再提醒一次，0 = 不重复（默认 0）
 *   ALERT_URL             邮件里附的状态页地址
 *
 * 没配齐时安静地禁用，不影响监控本身。
 */
import { sendMail } from "./mailer.js";

const STATE_LABEL = {
  up: "正常运行",
  degraded: "响应变慢",
  down: "不可用",
  unknown: "状态未知",
};

function humanDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function formatTime(ts, timeZone) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .format(new Date(ts))
      .replaceAll("/", "-");
  } catch {
    return new Date(ts).toISOString();
  }
}

export function readAlertSettings(defaultTimezone = "Asia/Shanghai") {
  const host = process.env.ALERT_SMTP_HOST?.trim();
  const recipients = String(process.env.ALERT_TO ?? "")
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!host || !recipients.length) return null;

  const secure = /^(1|true|yes|on)$/i.test(process.env.ALERT_SMTP_SECURE ?? "");
  const user = process.env.ALERT_SMTP_USER?.trim() ?? "";
  const pass = process.env.ALERT_SMTP_PASS ?? "";
  const from = process.env.ALERT_FROM?.trim() || user;
  if (!from) return null;

  return {
    host,
    port: Number(process.env.ALERT_SMTP_PORT ?? (secure ? 465 : 587)),
    secure,
    user,
    pass,
    from,
    recipients,
    repeatMs: Math.max(0, Number(process.env.ALERT_REPEAT_MINUTES ?? 0)) * 60000,
    url: process.env.ALERT_URL?.trim() || "",
    timezone: process.env.ALERT_TZ?.trim() || process.env.TZ || defaultTimezone,
  };
}

export function createAlerter({ siteName = "fnOS 状态页", timezone = "Asia/Shanghai", logger = console } = {}) {
  const settings = readAlertSettings(timezone);
  if (!settings) {
    return {
      enabled: false,
      notify() {},
      describe: () => "邮件通知未启用（设置 ALERT_SMTP_HOST 与 ALERT_TO 后重启）",
    };
  }

  const lastSent = new Map();
  let chain = Promise.resolve();

  function compose(event) {
    const { type, service, incident } = event;
    const group = service.group ? `（${service.group}）` : "";
    const label = STATE_LABEL[incident.currentState] ?? STATE_LABEL.unknown;
    const start = formatTime(incident.startedAt, settings.timezone);
    const elapsed = humanDuration(Date.now() - incident.startedAt);

    if (type === "opened") {
      return {
        subject: `[异常] ${service.name} ${label} · ${siteName}`,
        text: [
          `${siteName} · 服务异常`,
          "",
          `服务：${service.name}${group}`,
          `状态：${label}`,
          `开始时间：${start}`,
          `原因：${incident.reason || "检查失败"}`,
          "",
          ...(settings.url ? [`状态页：${settings.url}`, ""] : []),
          "—— 由 fnos-monitor 自动发送，请勿直接回复",
        ].join("\n"),
      };
    }

    if (type === "resolved") {
      const resolvedAt = incident.resolvedAt ?? Date.now();
      return {
        subject: `[恢复] ${service.name} 已恢复 · ${siteName}`,
        text: [
          `${siteName} · 服务已恢复`,
          "",
          `服务：${service.name}${group}`,
          "状态：已恢复正常",
          `开始时间：${start}`,
          `恢复时间：${formatTime(resolvedAt, settings.timezone)}`,
          `持续时间：${humanDuration(resolvedAt - incident.startedAt)}`,
          "",
          ...(settings.url ? [`状态页：${settings.url}`, ""] : []),
          "—— 由 fnos-monitor 自动发送，请勿直接回复",
        ].join("\n"),
      };
    }

    return {
      subject: `[仍未恢复] ${service.name} ${label} · ${siteName}`,
      text: [
        `${siteName} · 服务仍未恢复`,
        "",
        `服务：${service.name}${group}`,
        `状态：${label}`,
        `开始时间：${start}`,
        `已持续：${elapsed}`,
        `原因：${incident.reason || "检查失败"}`,
        "",
        ...(settings.url ? [`状态页：${settings.url}`, ""] : []),
        "—— 由 fnos-monitor 自动发送，请勿直接回复",
      ].join("\n"),
    };
  }

  async function deliver(event) {
    const incidentId = event.incident?.id;
    if (!incidentId) return;

    if (event.type === "reminder") {
      if (!settings.repeatMs || event.incident.state !== "open") return;
      const sentAt = lastSent.get(incidentId);
      if (!sentAt || Date.now() - sentAt < settings.repeatMs) return;
    }

    const mail = compose(event);
    await sendMail({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      user: settings.user,
      pass: settings.pass,
      from: settings.from,
      to: settings.recipients,
      subject: mail.subject,
      text: mail.text,
    });
    lastSent.set(incidentId, Date.now());
    logger.info(`[alert] 已发送邮件：${mail.subject}`);
  }

  return {
    enabled: true,
    describe: () =>
      `邮件通知已启用：${settings.host}:${settings.port} → ${settings.recipients.join(", ")}` +
      (settings.repeatMs ? `（每 ${settings.repeatMs / 60000} 分钟重复提醒）` : ""),
    notify(event) {
      chain = chain
        .then(() => deliver(event))
        .catch((err) => {
          logger.error(`[alert] 邮件发送失败：${err.message}`);
        });
      return chain;
    },
  };
}
