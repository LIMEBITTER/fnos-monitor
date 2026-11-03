/**
 * 初始化（或重置）网页管理员账号。
 *
 * 用法：
 *   node scripts/set-admin.mjs                      # 自动生成 16 位密码并打印
 *   node scripts/set-admin.mjs --user eric          # 指定用户名
 *   node scripts/set-admin.mjs --password 'xxxxx'   # 指定密码（至少 8 位）
 *
 * 结果写入 DATA_DIR/settings.json（默认 data/），不提交仓库。
 * 之后打开 /settings 用这组账号登录，就能在网页里改邮件告警、站点信息与探测间隔。
 */
import crypto from "node:crypto";
import path from "node:path";
import { createAdmin, loadSettings, saveSettings, settingsFile } from "../server/settings.js";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(import.meta.dirname, "..", "data"));
const user = arg("user", "admin");
const password = arg("password") || crypto.randomBytes(12).toString("base64url").slice(0, 16);

if (password.length < 8) {
  console.error("密码至少 8 位");
  process.exit(1);
}

const settings = loadSettings(dataDir);
settings.admin = createAdmin(user, password);
saveSettings(settings);

console.log(`管理员已保存：${user}`);
console.log(`文件：${settingsFile(dataDir)}（权限 600）`);
console.log(`密码：${password}`);
console.log("打开状态页右上角「设置」或 /settings 登录，登录后即可修改邮件告警与探测间隔。");
