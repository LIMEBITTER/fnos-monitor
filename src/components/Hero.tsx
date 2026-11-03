import { useCountUp } from "../lib/hooks";
import { formatPercent, formatRelative, stateLabel } from "../lib/format";
import type { StatusPayload } from "../types";

interface Props {
  status: StatusPayload;
}

export function Hero({ status }: Props) {
  const { overall, site, services, incidents, generatedAt } = status;
  const uptime = useCountUp(overall.uptime90);
  const openIncidents = incidents.filter((i) => i.state === "open").length;

  return (
    <section className={`hero state-${overall.state}`}>
      <div className="hero-status" role="status" aria-live="polite">
        <span className={`status-dot state-${overall.state}`} aria-hidden="true">
          <i />
        </span>
        <span className="hero-status-text">{overall.message}</span>
      </div>

      <h1 className="hero-title">
        {site.name}
        <span className="hero-title-accent">运行状态</span>
      </h1>
      <p className="hero-desc">{site.description}</p>

      <div className="hero-stats">
        <div className="stat stat-main">
          <span className="stat-label">90 天可用率</span>
          <span className="stat-value">
            {uptime === null ? "—" : uptime.toFixed(2)}
            <em>%</em>
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">监控服务</span>
          <span className="stat-value">
            {services.length}
            <em>个</em>
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">进行中事故</span>
          <span className="stat-value">
            {openIncidents}
            <em>起</em>
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">更新于</span>
          <span className="stat-value stat-value-sm">{formatRelative(generatedAt)}</span>
        </div>
      </div>

      <p className="hero-note">
        总体状态：{stateLabel(overall.state)} · 不可用 {overall.downCount} · 变慢 {overall.degradedCount} · 共{" "}
        {overall.serviceCount} 个服务
        {overall.uptime90 !== null ? ` · 平均可用率 ${formatPercent(overall.uptime90)}` : ""}
      </p>
    </section>
  );
}
