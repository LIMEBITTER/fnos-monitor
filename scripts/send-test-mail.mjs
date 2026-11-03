/**
 * 发送一封测试邮件，验证 ALERT_* 配置是否可用。
 * 用法：node scripts/send-test-mail.mjs
 */
import { readAlertSettings, sendTestMail } from "../server/alerts.js";

const settings = readAlertSettings();
if (!settings) {
  console.error("未配置邮件通知：请设置 ALERT_SMTP_HOST 与 ALERT_TO（或先在设置页保存邮件配置）。");
  process.exit(1);
}

const result = await sendTestMail(settings);
console.log(`已发送测试邮件到 ${result.to.join(", ")}（${result.elapsedMs} ms）`);
