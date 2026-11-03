/**
 * 持久化与聚合。
 *
 * 设计目标：迁移只需带走 data/state.json 和 config/services.json，
 * 所以不引数据库、不用原生模块；单文件 JSON + 原子写。
 *
 * 每个服务保存：
 *   - checks：最近 N 次检查（给 24h 折线用，N 默认 360）
 *   - days：按本地日期聚合的 90 天计数（总量小，够画可用率条和日历）
 *   - state / since / last：当前状态与最近一次结果
 */
import fs from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayKeys(count, now = Date.now()) {
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    keys.push(dayKey(now - i * 86400000));
  }
  return keys;
}

function emptyDay() {
  return { up: 0, degraded: 0, down: 0, total: 0, msSum: 0, msCount: 0, msMax: 0 };
}

function emptyService() {
  return { state: "unknown", since: null, last: null, checks: [], days: {} };
}

export class Store {
  constructor({ file, historyDays, maxChecks }) {
    this.file = file;
    this.historyDays = historyDays;
    this.maxChecks = maxChecks;
    this.data = { version: STATE_VERSION, startedAt: Date.now(), services: {}, incidents: [] };
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.save();
      return this;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
      this.data = {
        version: STATE_VERSION,
        startedAt: Number(raw.startedAt ?? Date.now()),
        services: raw.services ?? {},
        incidents: Array.isArray(raw.incidents) ? raw.incidents : [],
      };
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.file, backup);
      console.error(`[store] 状态文件损坏，已备份到 ${backup}，重新开始：${err.message}`);
      this.data = { version: STATE_VERSION, startedAt: Date.now(), services: {}, incidents: [] };
      this.save();
    }
    return this;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  ensureService(id) {
    if (!this.data.services[id]) this.data.services[id] = emptyService();
    return this.data.services[id];
  }

  openIncident(serviceId) {
    return this.data.incidents.find((i) => i.serviceId === serviceId && i.state === "open") ?? null;
  }

  /** 记录一次检查结果，返回是否新建/关闭了事故（用于日志）。 */
  record(serviceId, result, at = Date.now()) {
    const svc = this.ensureService(serviceId);
    const prevState = svc.state;
    const key = dayKey(at);

    if (svc.state !== result.state || svc.since === null) {
      svc.since = at;
    }
    svc.state = result.state;
    svc.last = { t: at, state: result.state, ms: result.ms, code: result.code, error: result.error ?? "" };

    svc.checks.push({ t: at, s: result.state, ms: result.ms, code: result.code, e: result.error ?? "" });
    if (svc.checks.length > this.maxChecks) svc.checks.splice(0, svc.checks.length - this.maxChecks);

    const day = (svc.days[key] ??= emptyDay());
    day.total += 1;
    if (result.state === "down") {
      day.down += 1;
    } else {
      day[result.state] += 1;
      day.msSum += result.ms;
      day.msCount += 1;
      day.msMax = Math.max(day.msMax, result.ms);
    }

    this.pruneDays(svc, at);
    return this.trackIncident(serviceId, prevState, result, at);
  }

  pruneDays(svc, now) {
    const keep = new Set(dayKeys(this.historyDays, now));
    for (const key of Object.keys(svc.days)) {
      if (!keep.has(key)) delete svc.days[key];
    }
  }

  pruneIncidents(now) {
    const cutoff = now - Math.max(this.historyDays, 180) * 86400000;
    this.data.incidents = this.data.incidents
      .filter((i) => i.state === "open" || (i.resolvedAt ?? i.startedAt) >= cutoff)
      .slice(0, 200);
  }

  trackIncident(serviceId, prevState, result, at) {
    const open = this.openIncident(serviceId);

    if (result.state === "up") {
      if (!open) return null;
      open.state = "resolved";
      open.resolvedAt = at;
      open.currentState = "up";
      open.updates.push({ at, state: "up", text: "已恢复" });
      return { type: "resolved", incident: open };
    }

    if (!open) {
      const incident = {
        id: `inc-${at}-${Math.random().toString(36).slice(2, 7)}`,
        serviceId,
        severity: result.state === "down" ? "major" : "minor",
        state: "open",
        currentState: result.state,
        startedAt: at,
        resolvedAt: null,
        reason: result.error || (result.state === "down" ? "检查失败" : "响应变慢"),
        updates: [{ at, state: result.state, text: result.error || "状态异常" }],
      };
      this.data.incidents.unshift(incident);
      return { type: "opened", incident };
    }

    if (open.currentState !== result.state) {
      open.currentState = result.state;
      open.severity = result.state === "down" ? "major" : open.severity;
      if (result.state === "degraded" && open.severity === "major") open.severity = "major";
      open.updates.push({ at, state: result.state, text: result.error || "状态变化" });
      return { type: "updated", incident: open };
    }

    void prevState;
    return null;
  }

  // ---------------------------------------------------------------- 视图 ---

  /** 某服务最近 N 天的日聚合（缺失的日期补空）。 */
  serviceDays(serviceId, count) {
    const svc = this.data.services[serviceId] ?? emptyService();
    return dayKeys(count).map((date) => {
      const d = svc.days[date];
      if (!d || !d.total) return { date, uptime: null, state: "none", total: 0, avgMs: null };
      const uptime = ((d.up + d.degraded) / d.total) * 100;
      const state = d.down > 0 ? "down" : d.degraded > 0 ? "degraded" : "up";
      return {
        date,
        uptime: Math.round(uptime * 100) / 100,
        state,
        total: d.total,
        avgMs: d.msCount ? Math.round(d.msSum / d.msCount) : null,
      };
    });
  }

  buildStatus(config, runtime) {
    const now = Date.now();
    const services = config.services
      .filter((s) => !s.hidden)
      .map((s) => {
        const svc = this.data.services[s.id] ?? emptyService();
        const days = this.serviceDays(s.id, config.historyDays);
        const withData = days.filter((d) => d.total > 0);
        const totalChecks = withData.reduce((sum, d) => sum + d.total, 0);
        const uptime90 = withData.length
          ? withData.reduce((sum, d) => sum + d.uptime * d.total, 0) / totalChecks
          : null;

        return {
          id: s.id,
          name: s.name,
          group: s.group,
          description: s.description,
          type: s.type,
          target: s.type === "tcp" ? `${s.host}:${s.port}` : s.url,
          state: svc.state,
          since: svc.since,
          lastCheckAt: svc.last?.t ?? null,
          latencyMs: svc.last?.ms ?? null,
          slowMs: s.slowMs,
          uptime90: uptime90 === null ? null : Math.round(uptime90 * 100) / 100,
          days,
          checks: svc.checks.slice(-60).map((c) => ({ t: c.t, state: c.s, ms: c.ms, code: c.code, error: c.e })),
        };
      });

    const down = services.filter((s) => s.state === "down");
    const degraded = services.filter((s) => s.state === "degraded");
    const healthy = services.filter((s) => s.state === "up" || s.state === "degraded");
    const overallState = down.length ? "down" : degraded.length ? "degraded" : healthy.length ? "up" : "unknown";
    const knownUptimes = services.map((s) => s.uptime90).filter((u) => u !== null);

    const calendar = {};
    for (const key of dayKeys(Math.max(config.historyDays, 120), now)) calendar[key] = emptyDay();
    for (const s of config.services) {
      const svc = this.data.services[s.id];
      if (!svc) continue;
      for (const [date, d] of Object.entries(svc.days)) {
        const slot = (calendar[date] ??= emptyDay());
        slot.up += d.up;
        slot.degraded += d.degraded;
        slot.down += d.down;
        slot.total += d.total;
      }
    }
    for (const d of Object.values(calendar)) {
      d.state = d.total === 0 ? "none" : d.down > 0 ? "down" : d.degraded > 0 ? "degraded" : "up";
      delete d.msSum;
      delete d.msCount;
      delete d.msMax;
    }

    const incidents = this.data.incidents
      .slice(0, 40)
      .map((i) => ({
        ...i,
        serviceName: config.services.find((s) => s.id === i.serviceId)?.name ?? i.serviceId,
      }));

    return {
      site: config.site,
      generatedAt: now,
      overall: {
        state: overallState,
        message: down.length
          ? `${down.length} 个服务不可用`
          : degraded.length
            ? `${degraded.length} 个服务响应变慢`
            : healthy.length
              ? "所有系统运行正常"
              : "正在采集首次数据…",
        uptime90: knownUptimes.length
          ? Math.round((knownUptimes.reduce((sum, u) => sum + u, 0) / knownUptimes.length) * 100) / 100
          : null,
        downCount: down.length,
        degradedCount: degraded.length,
        serviceCount: services.length,
      },
      services,
      incidents,
      calendar,
      meta: {
        intervalSeconds: config.checkIntervalSeconds,
        historyDays: config.historyDays,
        version: runtime.version,
        startedAt: this.data.startedAt,
        configFile: path.basename(config.file),
        isExample: config.isExample,
      },
    };
  }
}
