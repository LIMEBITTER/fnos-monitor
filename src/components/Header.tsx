import type { StatusPayload } from "../types";

interface Props {
  site: StatusPayload["site"];
  connected: boolean;
  theme: "dark" | "light";
  publicView?: boolean;
  onToggleTheme: () => void;
}

export function Header({ site, connected, theme, publicView = false, onToggleTheme }: Props) {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="回到首页">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="22" height="22" fill="none">
            <path
              d="M4 21h5l3.2-9.5L16 27l3.4-11H28"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="brand-text">
          <strong>{site.name}</strong>
          <small>状态页</small>
        </span>
      </a>

      <div className="topbar-right">
        {publicView ? (
          <span className="vision" title="公网视图：探测目标、错误详情与版本号已隐藏">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
              <path
                d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v9H6z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
            已脱敏
          </span>
        ) : null}
        <span className={`live ${connected ? "is-live" : ""}`} title={connected ? "SSE 实时推送中" : "SSE 断开，改用轮询"}>
          <i aria-hidden="true" />
          {connected ? "实时" : "轮询"}
        </span>
        <button className="theme-toggle" type="button" onClick={onToggleTheme} aria-label="切换深色/浅色模式">
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          <span>{theme === "dark" ? "浅色" : "深色"}</span>
        </button>
      </div>
    </header>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
