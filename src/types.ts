export type ServiceState = "up" | "degraded" | "down" | "unknown";
export type DayState = ServiceState | "none";

export interface DayCell {
  date: string;
  uptime: number | null;
  state: DayState;
  total: number;
  avgMs: number | null;
}

export interface CheckPoint {
  t: number;
  state: ServiceState;
  ms: number;
  code: number | null;
  error: string;
}

export interface ServiceStatus {
  id: string;
  name: string;
  group: string;
  description: string;
  type: "http" | "tcp";
  /** 公网视图里为 null（不暴露内网地址） */
  target: string | null;
  state: ServiceState;
  since: number | null;
  lastCheckAt: number | null;
  latencyMs: number | null;
  slowMs: number;
  uptime90: number | null;
  days: DayCell[];
  checks: CheckPoint[];
}

export interface IncidentUpdate {
  at: number;
  state: ServiceState;
  text: string;
}

export interface Incident {
  id: string;
  serviceId: string;
  serviceName: string;
  severity: "major" | "minor";
  state: "open" | "resolved";
  currentState: ServiceState;
  startedAt: number;
  resolvedAt: number | null;
  reason: string;
  updates: IncidentUpdate[];
}

export interface CalendarDay {
  up: number;
  degraded: number;
  down: number;
  total: number;
  state: DayState;
}

export interface StatusPayload {
  site: { name: string; description: string; timezone: string };
  generatedAt: number;
  overall: {
    state: ServiceState;
    message: string;
    uptime90: number | null;
    downCount: number;
    degradedCount: number;
    serviceCount: number;
  };
  services: ServiceStatus[];
  incidents: Incident[];
  calendar: Record<string, CalendarDay>;
  meta: {
    intervalSeconds: number;
    historyDays: number;
    /** 公网视图下这些字段为空/零 */
    version: string;
    startedAt: number | null;
    configFile: string;
    isExample: boolean;
    publicView?: boolean;
  };
}

export interface SessionInfo {
  ok: boolean;
  authenticated: boolean;
  user: string | null;
  source: "env" | "file" | null;
  canManage: boolean;
}

export interface SettingsPayload {
  ok: boolean;
  admin: { user: string; source: "env" | "file" } | null;
  alerts: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    hasPass: boolean;
    from: string;
    to: string[];
    repeatMinutes: number;
    url: string;
  };
  site: { name: string; description: string };
  probe: { checkIntervalSeconds: number };
  envManaged: { auth: boolean; smtp: boolean };
}
