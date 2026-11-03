export function formatPercent(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatRelative(ts: number | null, now = Date.now()): string {
  if (!ts) return "—";
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export function formatDuration(from: number, to: number | null, now = Date.now()): string {
  const end = to ?? now;
  const diff = Math.max(0, end - from);
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟`;
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    const mins = Math.round((diff % 3_600_000) / 60_000);
    return mins ? `${hours} 小时 ${mins} 分` : `${hours} 小时`;
  }
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.round((diff % 86_400_000) / 3_600_000);
  return hours ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

export function formatDateTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export function stateLabel(state: string): string {
  switch (state) {
    case "up":
      return "运行正常";
    case "degraded":
      return "响应变慢";
    case "down":
      return "不可用";
    default:
      return "未知";
  }
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
