import { useMemo, useState } from "react";
import { formatPercent } from "../lib/format";
import type { CalendarDay, DayState } from "../types";

interface Props {
  calendar: Record<string, CalendarDay>;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const MONTHS = [
  "1 月",
  "2 月",
  "3 月",
  "4 月",
  "5 月",
  "6 月",
  "7 月",
  "8 月",
  "9 月",
  "10 月",
  "11 月",
  "12 月",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function Calendar({ calendar }: Props) {
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => ({ year: today.getFullYear(), month: today.getMonth() }));

  const first = new Date(cursor.year, cursor.month, 1);
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const isCurrentMonth = cursor.year === today.getFullYear() && cursor.month === today.getMonth();

  const cells: Array<{ key: string; day: number; cell: CalendarDay | null } | null> = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${cursor.year}-${pad(cursor.month + 1)}-${pad(day)}`;
    cells.push({ key, day, cell: calendar[key] ?? null });
  }

  const monthStats = cells.reduce(
    (acc, c) => {
      if (!c?.cell || c.cell.total === 0) return acc;
      acc.total += c.cell.total;
      acc.up += c.cell.up;
      acc.degraded += c.cell.degraded;
      acc.down += c.cell.down;
      return acc;
    },
    { total: 0, up: 0, degraded: 0, down: 0 },
  );
  const monthUptime = monthStats.total ? (monthStats.up / monthStats.total) * 100 : null;

  const shift = (delta: number) => {
    const d = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
  };
  const goToday = () => setCursor({ year: today.getFullYear(), month: today.getMonth() });

  return (
    <section className="panel calendar" aria-labelledby="calendar-title">
      <div className="panel-head">
        <h2 id="calendar-title">每日可用率</h2>
        <div className="cal-nav">
          <button type="button" onClick={() => shift(-1)} aria-label="上个月">
            ‹
          </button>
          <button type="button" className="cal-label" onClick={goToday} title="回到本月">
            {cursor.year} 年 {MONTHS[cursor.month]}
          </button>
          <button type="button" onClick={() => shift(1)} disabled={isCurrentMonth} aria-label="下个月">
            ›
          </button>
        </div>
      </div>

      <div className="cal-grid" role="grid" aria-label="每日可用率日历">
        {WEEKDAYS.map((w) => (
          <span key={w} className="cal-weekday" role="columnheader">
            {w}
          </span>
        ))}
        {cells.map((cell, i) =>
          cell === null ? (
            <span key={`blank-${i}`} className="cal-day is-blank" />
          ) : (
            <span
              key={cell.key}
              className={`cal-day ${cell.cell ? `state-${cell.cell.state}` : "state-none"} ${
                cell.key === todayKey ? "is-today" : ""
              }`}
              role="gridcell"
              title={
                cell.cell && cell.cell.total > 0
                  ? `${cell.key}：可用率 ${formatPercent((cell.cell.up / cell.cell.total) * 100)} · 正常 ${cell.cell.up} 次 / 变慢 ${cell.cell.degraded} 次 / 不可用 ${cell.cell.down} 次`
                  : `${cell.key}：暂无数据`
              }
            >
              {cell.day}
            </span>
          ),
        )}
      </div>

      <div className="cal-foot">
        <span className="cal-summary">
          本月平均 <strong>{formatPercent(monthUptime)}</strong>
          {monthStats.down ? ` · ${monthStats.down} 次不可用` : " · 无不可用记录"}
        </span>
        <Legend />
      </div>
    </section>
  );
}

export function Legend() {
  const items: Array<{ state: DayState; label: string }> = [
    { state: "up", label: "正常" },
    { state: "degraded", label: "变慢" },
    { state: "down", label: "不可用" },
    { state: "none", label: "无数据" },
  ];
  return (
    <span className="legend">
      {items.map((item) => (
        <span key={item.state} className="legend-item">
          <i className={`state-${item.state}`} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </span>
  );
}
