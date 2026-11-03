/**
 * 采集调度：按间隔并发跑所有服务，写 store，再通知订阅者（SSE 广播）。
 * 用递归 setTimeout 而不是 setInterval，避免上一次没跑完就叠下一次。
 */
import { runCheck } from "./checks.js";

export function createScheduler({ config, store, onUpdate, notify, logger = console }) {
  let timer = null;
  let stopped = false;
  let ticking = false;
  let lastRunAt = 0;

  async function tick() {
    if (ticking) return { skipped: true };
    ticking = true;
    const startedAt = Date.now();
    let up = 0;
    let degraded = 0;
    let down = 0;

    try {
      const settled = await Promise.allSettled(
        config.services.map(async (service) => ({ service, result: await runCheck(service) })),
      );

      for (const item of settled) {
        if (item.status !== "fulfilled") {
          logger.error("[scheduler] 检查抛错：", item.reason);
          continue;
        }
        const { service, result } = item.value;
        if (result.state === "up") up += 1;
        else if (result.state === "degraded") degraded += 1;
        else down += 1;

        const event = store.record(service.id, result, Date.now());
        if (event?.type === "opened") {
          logger.warn(`[incident] ${service.name} 异常：${event.incident.reason}`);
          notify?.({ type: "opened", service, incident: event.incident });
        } else if (event?.type === "resolved") {
          logger.info(`[incident] ${service.name} 已恢复`);
          notify?.({ type: "resolved", service, incident: event.incident });
        }
      }

      store.pruneIncidents(Date.now());
      store.save();

      if (notify) {
        for (const incident of store.openIncidents()) {
          const service = config.services.find((s) => s.id === incident.serviceId);
          if (service) notify({ type: "reminder", service, incident });
        }
      }
      lastRunAt = Date.now();
      onUpdate?.({ up, degraded, down, durationMs: Date.now() - startedAt });
    } catch (err) {
      logger.error("[scheduler] 本轮检查失败：", err);
    } finally {
      ticking = false;
    }

    return { up, degraded, down };
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await tick();
      scheduleNext();
    }, config.checkIntervalSeconds * 1000);
    timer.unref?.();
  }

  return {
    lastRunAt: () => lastRunAt,
    isTicking: () => ticking,
    async start() {
      stopped = false;
      await tick();
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tick,
  };
}
