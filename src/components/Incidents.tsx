import type { CSSProperties } from "react";
import { formatDateTime, formatDuration, stateLabel } from "../lib/format";
import type { Incident } from "../types";

interface Props {
  incidents: Incident[];
}

export function Incidents({ incidents }: Props) {
  const open = incidents.filter((i) => i.state === "open");
  const resolved = incidents.filter((i) => i.state === "resolved");

  return (
    <section className="panel incidents" aria-labelledby="incidents-title">
      <div className="panel-head">
        <h2 id="incidents-title">事故记录</h2>
        <span className="panel-sub">
          最近 90 天 · {incidents.length} 起
          {open.length ? ` · ${open.length} 起进行中` : ""}
        </span>
      </div>

      {incidents.length === 0 ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
              <path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <p className="empty-title">一切正常</p>
            <p className="empty-sub">过去 90 天没有记录到事故，服务一直保持可用。</p>
          </div>
        </div>
      ) : (
        <ol className="incident-list">
          {[...open, ...resolved].map((incident, i) => (
            <li
              key={incident.id}
              className={`incident severity-${incident.severity} ${incident.state}`}
              style={{ "--i": i } as CSSProperties}
            >
              <span className={`incident-dot state-${incident.currentState}`} aria-hidden="true" />
              <div className="incident-body">
                <div className="incident-top">
                  <strong>{incident.serviceName}</strong>
                  <span className={`incident-tag ${incident.state}`}>
                    {incident.state === "open" ? "进行中" : "已恢复"}
                  </span>
                  <span className="incident-severity">
                    {incident.severity === "major" ? "严重" : "性能下降"}
                  </span>
                </div>
                <p className="incident-reason">{incident.reason}</p>
                <div className="incident-meta">
                  <span>{formatDateTime(incident.startedAt)} 开始</span>
                  <span>持续 {formatDuration(incident.startedAt, incident.resolvedAt)}</span>
                  <span>
                    当前：{stateLabel(incident.currentState)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
