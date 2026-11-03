/**
 * 发送一封测试邮件，验证 ALERT_* 配置是否可用。
 * 用法：node scripts/send-test-mail.mjs
 */
import { readAlertSettings } from "../server/alerts.js";
import { sendMail } from "../server/mailer.js";

const settings = readAlertSettings();
if (!settings) {
  console.error("未配置邮件通知：请设置 ALERT_SMTP_HOST 与 ALERT_TO（其余变量可选）。");
  process.exit(1);
}

const to = settings.recipients;
const now = new Intl.DateTimeFormat("zh-CN", {
  timeZone: settings.timezone,
  dateStyle: "full",
  timeStyle: "medium",
}).format(new Date());

const text = [
  "这是一封来自 fnOS 监控状态页的测试邮件。",
  "",
  "收到它说明 SMTP 配置可用，服务异常时你会收到同类通知。",
  `发送时间：${now}`,
  `SMTP：${settings.host}:${settings.port}（${settings.secure ? "SSL/TLS" : "STARTTLS/明文"}）`,
  `收件人：${to.join(", ")}`,
  settings.url ? `状态页：${settings.url}` : "",
  "",
  "由 fnos-monitor 自动发送，请勿直接回复。",
]
  .filter(Boolean)
  .join("\r\n");

const started = Date.now();
await sendMail({
  host: settings.host,
  port: settings.port,
  secure: settings.secure,
  user: settings.user,
  pass: settings.pass,
  from: settings.from,
  to,
  subject: "[测试] fnOS 监控邮件通知",
  text,
});

console.log(`已发送测试邮件到 ${to.join(", ")}（${Date.now() - started} ms）`);
