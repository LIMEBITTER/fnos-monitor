/**
 * 公网视图：把内部状态裁剪成可以公开的数据。
 *
 * 状态页默认面向公网，所以默认只输出「结论」而不输出「路径」：
 *   - 探测目标（127.0.0.1:3080、192.168.31.217:5099、::1:57921）会暴露内网结构
 *   - 检查记录里的状态码 / 错误原文可能带 IP、端口、主机名
 *   - meta 里的版本号、配置文件名、启动时间属于内部信息
 *
 * 想在本机或内网看完整信息：设置 EXPOSE_INTERNAL=true；
 * 或者开启 Basic Auth 后用账号访问（登录用户始终看完整视图）。
 */

/** 错误原文里可能出现的内部地址，统一替换成占位符。宁可多删，不要漏。 */
const PATTERNS = [
  /(?:https?|wss?):\/\/[^\s"'<>，。；、（）()]+/gi,
  /\[[0-9a-f:]+\](?::\d+)?/gi,
  /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g,
  /localhost(?::\d+)?/gi,
  // 压缩写法的 IPv6（::1、::1:8793、240e:3a4:4af1:66c0::fcc）
  /::[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){0,6}(?::\d{1,5})?/gi,
  // 完整写法的 IPv6（至少 4 组，避免误伤 HH:MM:SS 这类时间）
  /(?<![\w:])(?:[0-9a-f]{1,4}:){3,}[0-9a-f]{0,4}(?::\d{1,5})?/gi,
  /[A-Za-z0-9][A-Za-z0-9._-]*\.(?:lan|local|internal|home|corp|intranet)(?::\d+)?/gi,
];

const PLACEHOLDER = "[内部地址]";

export function redactText(value) {
  if (!value) return "";
  return PATTERNS.reduce((text, pattern) => text.replace(pattern, PLACEHOLDER), String(value)).replace(
    /(\[内部地址]\s*)+/g,
    PLACEHOLDER,
  );
}

export function publicStatus(status) {
  return {
    site: status.site,
    generatedAt: status.generatedAt,
    overall: status.overall,
    services: status.services.map((service) => ({
      id: service.id,
      name: service.name,
      group: service.group,
      description: redactText(service.description),
      type: service.type,
      target: null,
      state: service.state,
      since: service.since,
      lastCheckAt: service.lastCheckAt,
      latencyMs: service.latencyMs,
      slowMs: 0,
      uptime90: service.uptime90,
      days: service.days,
      checks: service.checks.map((check) => ({
        t: check.t,
        state: check.state,
        ms: check.ms,
        code: null,
        error: "",
      })),
    })),
    incidents: status.incidents.map((incident) => ({
      ...incident,
      reason: redactText(incident.reason),
      updates: (incident.updates ?? []).map((update) => ({ ...update, text: redactText(update.text) })),
    })),
    calendar: status.calendar,
    meta: {
      intervalSeconds: status.meta.intervalSeconds,
      historyDays: status.meta.historyDays,
      version: "",
      startedAt: null,
      configFile: "",
      isExample: false,
      publicView: true,
    },
  };
}
