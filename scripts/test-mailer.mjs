/**
 * mailer.js 的离线自测：起一个假 SMTP 服务器，验证 HELO/AUTH/MAIL/RCPT/DATA 全流程。
 * 不连真实邮箱，也不需要凭据：node scripts/test-mailer.mjs
 */
import net from "node:net";
import { sendMail } from "../server/mailer.js";

function startFakeSmtp({ rejectAuth = false } = {}) {
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
        handle(line);
        if (inData) break;
      }
    });

    function handle(line) {
      if (authStep === 1) {
        authStep = 2;
        socket.write("334 UGFzc3dvcmQ6\r\n");
        return;
      }
      if (authStep === 2) {
        authStep = 0;
        socket.write(rejectAuth ? "535 5.7.8 认证失败\r\n" : "235 2.7.0 认证成功\r\n");
        return;
      }
      if (/^EHLO /i.test(line)) {
        socket.write("250-fake.smtp\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n");
      } else if (/^AUTH LOGIN/i.test(line)) {
        authStep = 1;
        socket.write("334 VXNlcm5hbWU6\r\n");
      } else if (/^AUTH PLAIN/i.test(line)) {
        socket.write(rejectAuth ? "535 5.7.8 认证失败\r\n" : "235 2.7.0 认证成功\r\n");
      } else if (/^MAIL FROM:/i.test(line)) {
        socket.write("250 2.1.0 ok\r\n");
      } else if (/^RCPT TO:/i.test(line)) {
        socket.write("250 2.1.5 ok\r\n");
      } else if (/^DATA$/i.test(line)) {
        inData = true;
        socket.write("354 开始输入邮件内容\r\n");
      } else if (/^QUIT$/i.test(line)) {
        socket.write("221 bye\r\n");
        socket.end();
      } else if (/^RSET$/i.test(line)) {
        socket.write("250 ok\r\n");
      } else {
        socket.write("250 ok\r\n");
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });
}

function decodeBase64Body(message) {
  const [, body = ""] = message.split("\r\n\r\n");
  return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
}

function assert(condition, label) {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${label}`);
}

const subject = "[异常] OneBot HTTP 不可用 · fnOS 关键业务";
const text = "服务：OneBot HTTP\n状态：不可用\n开始时间：2026-11-04 00:23:59";

const { server, received, port } = await startFakeSmtp();
await sendMail({
  host: "127.0.0.1",
  port,
  secure: false,
  user: "monitor@example.com",
  pass: "app-password",
  from: "fnOS 监控 <monitor@example.com>",
  to: ["me@example.com"],
  subject,
  text,
});
server.close();

assert(received.length === 1, "SMTP 收到 1 封邮件");
const message = received[0] ?? "";
assert(message.includes("From: fnOS 监控 <monitor@example.com>"), "From 头保留显示名");
assert(message.includes("To: me@example.com"), "To 头正确");
assert(/Subject: =\?UTF-8\?B\?/.test(message), "中文主题按 RFC 2047 编码");
assert(decodeBase64Body(message).replace(/\r\n/g, "\n") === text, "正文 base64 解码后与原文一致");
assert(/Content-Type: text\/plain; charset="utf-8"/.test(message), "Content-Type 为 UTF-8 纯文本");

// 认证失败时要抛错，并且错误信息带上服务器返回码
const failing = await startFakeSmtp({ rejectAuth: true });
let error = null;
try {
  await sendMail({
    host: "127.0.0.1",
    port: failing.port,
    secure: false,
    user: "monitor@example.com",
    pass: "wrong",
    from: "monitor@example.com",
    to: ["me@example.com"],
    subject: "test",
    text: "test",
  });
} catch (err) {
  error = err;
}
failing.server.close();
assert(error instanceof Error && /535/.test(error.message), `认证失败抛错：${error?.message ?? "未抛错"}`);

console.log(process.exitCode ? "\n邮件自测失败" : "\n邮件自测通过");
