/**
 * alerts.js 的离线自测：用假 SMTP 服务器验证邮件通知的触发条件与内容。
 * 不连真实邮箱：node scripts/test-alerts.mjs
 */
import net from "node:net";
import { createAlerter, readAlertSettings } from "../server/alerts.js";

function startFakeSmtp() {
  const received = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake.smtp ESMTP ready\r\n");

    let buffer = "";
    let inData = false;
    let authStep = 0;

    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (authStep === 1) {
          authStep = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (authStep === 2) {
          authStep = 0;
          socket.write("235 2.7.0 认证成功\r\n");
        } else if (/^EHLO /i.test(line)) {
          socket.write("250-fake.smtp\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n");
        } else if (/^AUTH LOGIN/i.test(line)) {
          authStep = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (/^AUTH PLAIN/i.test(line)) {
          socket.write("235 2.7.0 认证成功\r\n");
        } else if (/^DATA$/i.test(line)) {
          inData = true;
          socket.write("354 开始输入邮件内容\r\n");
        } else if (/^QUIT$/i.test(line)) {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });
}

function setupEnv(port, extra = {}) {
  Object.assign(process.env, {
    ALERT_SMTP_HOST: "127.0.0.1",
    ALERT_SMTP_PORT: String(port),
    ALERT_SMTP_SECURE: "false",
    ALERT_SMTP_USER: "monitor@example.com",
    ALERT_SMTP_PASS: "app-password",
    ALERT_TO: "me@example.com",
    ALERT_URL: "https://status.example.com/",
    ...extra,
  });
}

function clearEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ALERT_")) delete process.env[key];
  }
  delete process.env.TZ;
}

function decodeBody(message) {
  const [, body = ""] = message.split("\r\n\r\n");
  return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
}

function decodeSubject(message) {
  const line = message.split("\r\n").find((item) => /^Subject:/i.test(item)) ?? "";
  const encoded = line.replace(/^Subject:\s*/i, "").match(/=\?UTF-8\?B\?([^?]+)\?=/i);
  if (encoded) return Buffer.from(encoded[1], "base64").toString("utf8");
  return line.replace(/^Subject:\s*/i, "");
}

const checks = [];
function assert(condition, label) {
  checks.push({ ok: Boolean(condition), label });
  console.log(`${condition ? "✓" : "✗"} ${label}`);
}

const siteName = "fnOS 关键业务";
const service = { id: "onebot", name: "OneBot HTTP", group: "QQ" };
const incident = {
  id: "inc-1",
  state: "open",
  startedAt: Date.now() - 5 * 60000,
  currentState: "down",
  reason: "连接被拒绝 (ECONNREFUSED)",
};

const silent = [];
const fake = await startFakeSmtp();
setupEnv(fake.port);

const alerter = createAlerter({ siteName, timezone: "Asia/Shanghai", logger: { info() {}, error: (m) => silent.push(m) } });
assert(alerter.enabled, "配置齐全时启用邮件通知");
assert(/127\.0\.0\.1/.test(alerter.describe()), `describe 带上 SMTP 地址：${alerter.describe()}`);

await alerter.notify({ type: "opened", service, incident });
assert(fake.received.length === 1, "开事故后发出 1 封邮件");
const openMail = fake.received[0] ?? "";
assert(/Subject: =.*\?=/.test(openMail), "主题按 RFC 2047 编码");
const openBody = decodeBody(openMail);
const openSubject = decodeSubject(openMail);
assert(openSubject === "[异常] OneBot HTTP 不可用 · fnOS 关键业务", `主题包含服务名与状态：${openSubject}`);
assert(openBody.includes("原因：连接被拒绝 (ECONNREFUSED)"), "正文包含事故原因");
assert(openBody.includes("状态页：https://status.example.com/"), "正文包含状态页地址");

await alerter.notify({
  type: "resolved",
  service,
  incident: { ...incident, state: "resolved", resolvedAt: Date.now() },
});
assert(fake.received.length === 2, "恢复后发出第 2 封邮件");
assert(decodeSubject(fake.received[1]).includes("[恢复] OneBot HTTP 已恢复"), "恢复邮件标题为 [恢复]");

await alerter.notify({ type: "reminder", service, incident });
await alerter.notify({ type: "reminder", service, incident });
assert(fake.received.length === 2, "未开启重复提醒时不发送 reminder");

// 单独一组：开启重复提醒后，第二次 reminder 才会真正发信
setupEnv(fake.port, { ALERT_REPEAT_MINUTES: "0.01" });
const chatty = createAlerter({ siteName, timezone: "Asia/Shanghai", logger: { info() {}, error: (m) => silent.push(m) } });
await chatty.notify({ type: "opened", service, incident });
await chatty.notify({ type: "reminder", service, incident });
assert(fake.received.length === 3, "重复提醒间隔内被抑制");
await new Promise((r) => setTimeout(r, 800));
await chatty.notify({ type: "reminder", service, incident });
assert(fake.received.length === 4, "超过间隔后发送 reminder");
assert(decodeSubject(fake.received[3]).includes("[仍未恢复] OneBot HTTP 不可用"), "reminder 标题为 [仍未恢复]");

clearEnv();
const disabled = createAlerter({ siteName });
assert(!disabled.enabled, "缺少配置时静默禁用");
assert(readAlertSettings() === null, "缺少配置时 readAlertSettings 返回 null");

fake.server.close();
const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  process.exitCode = 1;
  console.error(`\n告警自测失败：${failed.length} 项未通过`);
} else {
  console.log("\n告警自测通过");
}
