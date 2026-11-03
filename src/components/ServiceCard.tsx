import type { CSSProperties } from "react";
import { useCountUp } from "../lib/hooks";
import { formatMs, formatRelative, stateLabel } from "../lib/format";
import type { DayCell, ServiceStatus } from "../types";

interface Props {
  service: ServiceStatus;
  index: number;
}

export function ServiceCard({ service, index }: Props) {
  const uptime = useCountUp(service.uptime90);
  const hasData = service.uptime90 !== null;

  return (
    <article
      className={`card state-${service.state}`}
      style={{ "--i": index } as CSSProperties}
      aria-label={`${service.name}：${stateLabel(service.state)}`}
    >
      <div className="card-head">
        <span className={`status-dot state-${service.state}`} aria-hidden="true">
          <i />
        </span>
        <h3 className="card-name">{service.name}</h3>
        {service.group ? <span className="chip">{service.group}</span> : null}
        <span className={`state-badge state-${service.state}`}>{stateLabel(service.state)}</span>
      </div>

      {service.description ? <p className="card-desc">{service.description}</p> : null}

      <div className="card-metrics">
        <div className="metric">
          <span className="metric-label">90 天可用率</span>
          <span className="metric-value">
            {hasData && uptime !== null ? (
              <>
                {uptime.toFixed(2)}
                <em>%</em>
              </>
            ) : (
              "—"
            )}
          </span>
        </div>
        <div className="metric metric-right">
          <span className="metric-label">当前延迟</span>
          <span className="metric-value metric-value-sm">{formatMs(service.latencyMs)}</span>
        </div>
        <Sparkline service={service} />
      </div>

      <UptimeBars days={service.days} name={service.name} />

      <div className="card-foot">
        <span className="card-target" title={service.target}>
          {service.type === "tcp" ? "TCP" : "HTTP"} · {service.target}
        </span>
        <span className="card-checked">检查于 {formatRelative(service.lastCheckAt)}</span>
      </div>
    </article>
  );
}

function UptimeBars({ days, name }: { days: DayCell[]; name: string }) {
  return (
    <div className="bars" role="img" aria-label={`${name} 最近 ${days.length} 天可用率`}>
      {days.map((day, i) => (
        <span
          key={day.date}
          className={`bar bar-${day.state}`}
          style={{ "--i": i } as CSSProperties}
          title={
            day.total === 0
              ? `${day.date}：无数据`
              : `${day.date}：${day.uptime?.toFixed(2)}% · 平均 ${formatMs(day.avgMs)}`
          }
        />
      ))}
    </div>
  );
}

function Sparkline({ service }: { service: ServiceStatus }) {
  const points = service.checks.filter((c) => c.state !== "down").slice(-40);
  if (points.length < 2) return <div className="spark spark-empty" />;

  const values = points.map((p) => p.ms);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);

  const coords = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100;
    const y = 26 - ((v - min) / span) * 22;
    return [x, y] as const;
  });

  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L100,28 L0,28 Z`;

  return (
    <svg className="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} pathLength={1} />
    </svg>
  );
}
