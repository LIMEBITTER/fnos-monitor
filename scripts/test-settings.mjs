/**
 * 设置与登录模块的自测：不启动 HTTP 服务，只验证 settings.js 的纯逻辑。
 * 覆盖：持久化、scrypt 密码、会话签名、字段校验、对外脱敏。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyToConfig,
  createAdmin,
  hashPassword,
  issueSession,
  loadSettings,
  parseRecipients,
  publicSettings,
  saveSettings,
  settingsFile,
  validatePatch,
  verifyPassword,
  verifySession,
} from "../server/settings.js";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(["✓", name]);
  } catch (error) {
    results.push(["✗", name, error.message]);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fnos-monitor-settings-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

test("首次加载会生成 sessionSecret 并标记 dirty", () => {
  const settings = loadSettings(dir);
  assert.equal(settings.sessionSecret.length, 64);
  assert.equal(settings.dirty, true);
  assert.equal(settings.file, settingsFile(dir));
});

test("保存后重新加载，密钥与管理员都还在", () => {
  const settings = loadSettings(dir);
  settings.admin = createAdmin("baiyu", "correct horse battery");
  settings.alerts = { host: "smtp.qq.com", port: 465, to: ["a@b.com"], pass: "secret" };
  saveSettings(settings);
  assert.equal(settings.dirty, false);

  const again = loadSettings(dir);
  assert.equal(again.sessionSecret, settings.sessionSecret);
  assert.equal(again.admin.user, "baiyu");
  assert.equal(again.alerts.host, "smtp.qq.com");
  if (process.platform !== "win32") assert.equal(fs.statSync(settingsFile(dir)).mode & 0o777, 0o600);
});

test("scrypt 密码校验：正确通过、错误拒绝", () => {
  const admin = hashPassword("s3cret-pass");
  assert.equal(verifyPassword("s3cret-pass", admin), true);
  assert.equal(verifyPassword("s3cret-pas", admin), false);
  assert.equal(verifyPassword("", admin), false);
  assert.equal(verifyPassword("x", null), false);
});

test("会话签名：往返成功、篡改与过期都拒绝", () => {
  const settings = loadSettings(dir);
  const now = Date.now();
  const { token } = issueSession(settings, "baiyu", now);
  assert.equal(verifySession(settings, token, now + 1000), "baiyu");
  assert.equal(verifySession(settings, token, now + 8 * 24 * 3600 * 1000), null);

  const [user, expires, signature] = token.split(".");
  assert.equal(verifySession(settings, `${user}.${expires}.${signature.slice(0, -2)}xx`, now), null);
  assert.equal(verifySession(settings, `${user}.${expires}`, now), null);
  assert.equal(verifySession(settings, "garbage", now), null);
});

test("收件人解析：逗号/分号/空白分隔并去重", () => {
  assert.deepEqual(parseRecipients("a@x.com, b@y.com;b@y.com\nc@z.com"), ["a@x.com", "b@y.com", "c@z.com"]);
  assert.deepEqual(parseRecipients(["a@x.com", " "]), ["a@x.com"]);
});

test("邮件设置校验：非法邮箱与超长列表被拒绝", () => {
  assert.throws(() => validatePatch({ alerts: { to: ["not-an-email"] } }), /不是合法邮箱/);
  assert.throws(
    () => validatePatch({ alerts: { to: Array.from({ length: 11 }, (_, i) => `u${i}@x.com`) } }),
    /最多 10 个/,
  );
  assert.throws(() => validatePatch({ alerts: { url: "ftp://x" } }), /http/);
  assert.throws(() => validatePatch({ alerts: { host: "smtp qq.com" } }), /不合法/);
});

test("邮件设置校验：密码留空保留、clearPass 清空、端口与间隔夹取", () => {
  const current = { alerts: { pass: "old", port: 465, to: ["a@x.com"] } };
  const kept = validatePatch({ alerts: { pass: "", port: 99999 } }, current);
  assert.equal(kept.alerts.pass, "old");
  assert.equal(kept.alerts.port, 65535);

  const cleared = validatePatch({ alerts: { clearPass: true } }, current);
  assert.equal(cleared.alerts.pass, "");

  const probe = validatePatch({ probe: { checkIntervalSeconds: 5 } }, {});
  assert.equal(probe.probe.checkIntervalSeconds, 10);
  assert.equal(validatePatch({ probe: { checkIntervalSeconds: 99999 } }, {}).probe.checkIntervalSeconds, 3600);
});

test("站点名称必填、描述限长", () => {
  assert.throws(() => validatePatch({ site: { name: "  " } }), /1–60/);
  assert.throws(() => validatePatch({ site: { description: "x".repeat(201) } }), /200/);
  assert.equal(validatePatch({ site: { name: "我的状态页" } }, {}).site.name, "我的状态页");
});

test("applyToConfig 落到站点与探测间隔", () => {
  const config = { site: { name: "old", description: "old" }, checkIntervalSeconds: 60 };
  applyToConfig({ site: { name: "new", description: "d" }, probe: { checkIntervalSeconds: 30 } }, config);
  assert.equal(config.site.name, "new");
  assert.equal(config.site.description, "d");
  assert.equal(config.checkIntervalSeconds, 30);
});

test("publicSettings 不泄露密码、哈希与会话密钥", () => {
  const settings = loadSettings(dir);
  settings.admin = createAdmin("baiyu", "pass-1234");
  settings.alerts = { host: "smtp.qq.com", pass: "smtp-secret", to: ["a@x.com"] };
  const view = publicSettings(settings);
  const text = JSON.stringify(view);
  assert.equal(text.includes("smtp-secret"), false);
  assert.equal(text.includes(settings.admin.hash), false);
  assert.equal(text.includes(settings.sessionSecret), false);
  assert.equal(view.alerts.hasPass, true);
  assert.equal(view.admin.user, "baiyu");
});

let failed = 0;
for (const [mark, name, detail] of results) {
  if (mark === "✗") failed += 1;
  console.log(`${mark} ${name}${detail ? `\n    ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed > 0 ? 1 : 0;
