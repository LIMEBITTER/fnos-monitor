/**
 * 极简 SMTP 客户端（只用 node:net / node:tls，不引第三方库）。
 *
 * 支持：
 *   - 465 直连 TLS（secure=true）、587 STARTTLS
 *   - AUTH LOGIN / AUTH PLAIN
 *   - 纯文本邮件（UTF-8，base64 正文，中文主题做 RFC 2047 编码）
 *
 * 只实现发信需要的最小子集：EHLO → [STARTTLS] → [AUTH] → MAIL/RCPT/DATA → QUIT。
 */
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

const DEFAULT_TIMEOUT = 25000;

function createReader(socket) {
  const responses = [];
  let waiter = null;
  let buffer = "";
  let lines = [];
  let failure = null;

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    pump();
  });
  socket.on("error", (err) => {
    failure ??= err;
    pump();
  });
  socket.on("close", () => {
    failure ??= new Error("SMTP 连接已关闭");
    pump();
  });

  function pump() {
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      lines.push(line);
      const match = /^(\d{3})([ -])/.exec(line);
      if (match && match[2] === " ") {
        const response = { code: Number(match[1]), text: lines.join("\n") };
        lines = [];
        if (waiter) {
          const pending = waiter;
          waiter = null;
          pending.resolve(response);
        } else {
          responses.push(response);
        }
      }
    }
    if (waiter && failure) {
      const pending = waiter;
      waiter = null;
      pending.reject(failure);
    }
  }

  return {
    read() {
      if (responses.length) return Promise.resolve(responses.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
  };
}

function encodeHeader(text) {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function buildMessage({ from, to, subject, text }) {
  const body = Buffer.from(String(text).replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${Date.now()}.${crypto.randomBytes(6).toString("hex")}@fnos-monitor>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

function addressOf(value) {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim();
}

export async function sendMail({
  host,
  port,
  secure = false,
  user = "",
  pass = "",
  from,
  to,
  subject,
  text,
  timeoutMs = DEFAULT_TIMEOUT,
}) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!host || !recipients.length) throw new Error("SMTP 参数不完整：需要 host 与收件人");

  let socket = secure
    ? tls.connect({ host, port, servername: host, timeout: timeoutMs })
    : net.connect({ host, port, timeout: timeoutMs });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`SMTP 超时（>${timeoutMs}ms）`)));

  let reader = createReader(socket);
  let current = socket;

  const write = (line) => current.write(`${line}\r\n`);
  async function expect(command, codes, label = command) {
    if (command) write(command);
    const response = await reader.read();
    if (!codes.includes(response.code)) {
      throw new Error(`SMTP ${label} 失败（${response.code}）：${response.text}`);
    }
    return response;
  }

  async function upgrade() {
    current = tls.connect({ socket: current, servername: host });
    await new Promise((resolve, reject) => {
      current.once("secureConnect", resolve);
      current.once("error", reject);
    });
    reader = createReader(current);
  }

  try {
    const greeting = await reader.read();
    if (greeting.code !== 220) throw new Error(`SMTP 问候失败（${greeting.code}）：${greeting.text}`);

    let response = await expect("EHLO fnos-monitor", [250], "EHLO");
    let capabilities = response.text;

    if (!secure && /STARTTLS/i.test(capabilities)) {
      await expect("STARTTLS", [220], "STARTTLS");
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      await upgrade();
      response = await expect("EHLO fnos-monitor", [250], "EHLO");
      capabilities = response.text;
    }

    if (user) {
      const supportsPlain = /AUTH[ =][^\n]*PLAIN/i.test(capabilities);
      const supportsLogin = /AUTH[ =][^\n]*LOGIN/i.test(capabilities);
      const tryLogin = async () => {
        write("AUTH LOGIN");
        let res = await reader.read();
        if (res.code !== 334) throw new Error(`SMTP AUTH LOGIN 失败（${res.code}）：${res.text}`);
        write(Buffer.from(user, "utf8").toString("base64"));
        res = await reader.read();
        if (res.code !== 334) throw new Error(`SMTP AUTH LOGIN 用户名失败（${res.code}）：${res.text}`);
        write(Buffer.from(pass, "utf8").toString("base64"));
        res = await reader.read();
        if (res.code !== 235) throw new Error(`SMTP 认证失败（${res.code}）：${res.text}`);
      };
      const tryPlain = async () => {
        write(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64")}`);
        const res = await reader.read();
        if (res.code !== 235) throw new Error(`SMTP 认证失败（${res.code}）：${res.text}`);
      };

      if (!supportsLogin && supportsPlain) {
        await tryPlain();
      } else {
        try {
          await tryLogin();
        } catch (err) {
          if (!supportsPlain) throw err;
          await tryPlain();
        }
      }
    }

    await expect(`MAIL FROM:<${addressOf(from)}>`, [250], "MAIL FROM");
    for (const recipient of recipients) {
      await expect(`RCPT TO:<${addressOf(recipient)}>`, [250, 251], "RCPT TO");
    }
    await expect("DATA", [354], "DATA");

    const message = buildMessage({ from: from.includes("<") ? from : `<${from}>`, to: recipients, subject, text });
    current.write(`${message}\r\n.\r\n`);
    await expect(null, [250], "邮件正文");

    write("QUIT");
    await reader.read().catch(() => null);
    current.end();
    return { accepted: recipients };
  } catch (err) {
    current.destroy();
    throw err;
  }
}
