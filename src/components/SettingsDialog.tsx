import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { SessionInfo, SettingsPayload } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface FormState {
  enabled: boolean;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  repeat: string;
  url: string;
  siteName: string;
  siteDesc: string;
  interval: string;
}

function toForm(payload: SettingsPayload): FormState {
  const { alerts, site, probe } = payload;
  return {
    enabled: Boolean(alerts.host),
    host: alerts.host,
    port: String(alerts.port),
    secure: alerts.secure,
    user: alerts.user,
    pass: "",
    from: alerts.from,
    to: alerts.to.join(", "),
    repeat: String(alerts.repeatMinutes),
    url: alerts.url,
    siteName: site.name,
    siteDesc: site.description,
    interval: String(probe.checkIntervalSeconds),
  };
}

export function SettingsDialog({ open, onClose }: Props) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsAdmin, setNeedsAdmin] = useState(false);
  const [login, setLogin] = useState({ user: "admin", password: "" });
  const [passwords, setPasswords] = useState({ current: "", next: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const info = await api<SessionInfo>("/api/session");
      setSession(info);
      if (!info.canManage) setNeedsAdmin(true);
      if (info.authenticated) {
        const payload = await api<SettingsPayload>("/api/settings");
        setSettings(payload);
        setForm(toForm(payload));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载设置失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setNotice("");
    setError("");
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  const update = (patch: Partial<FormState>) => setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    setBusy("login");
    setError("");
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify(login) });
      // 登录后重新加载页面：SSE 与首屏都会切到完整视图
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败");
    } finally {
      setBusy("");
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const body = {
        alerts: {
          host: form.enabled ? form.host.trim() : "",
          port: Number(form.port) || 465,
          secure: form.secure,
          user: form.user.trim(),
          ...(form.pass ? { pass: form.pass } : {}),
          from: form.from.trim(),
          to: form.to
            .split(/[,;\s]+/)
            .map((item) => item.trim())
            .filter(Boolean),
          repeatMinutes: Number(form.repeat) || 0,
          url: form.url.trim(),
        },
        site: { name: form.siteName.trim(), description: form.siteDesc.trim() },
        probe: { checkIntervalSeconds: Number(form.interval) || 60 },
      };
      const payload = await api<SettingsPayload>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setSettings(payload);
      setForm(toForm(payload));
      setNotice("设置已保存并立即生效");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setBusy("");
    }
  }

  async function sendTest() {
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const result = await api<{ to: string[] }>("/api/settings/test-mail", {
        method: "POST",
        body: "{}",
      });
      setNotice(`测试邮件已发送到 ${result.to.join(", ")}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "发送失败");
    } finally {
      setBusy("");
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy("password");
    setError("");
    setNotice("");
    try {
      await api("/api/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: passwords.current, newPassword: passwords.next }),
      });
      setPasswords({ current: "", next: "" });
      setNotice("密码已更新");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "修改失败");
    } finally {
      setBusy("");
    }
  }

  async function logout() {
    await api("/api/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    window.location.reload();
  }

  const authed = Boolean(session?.authenticated && form);

  return (
    <div className="set-mask" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="set-panel" role="dialog" aria-modal="true" aria-label="设置">
        <header className="set-head">
          <div>
            <h2>设置</h2>
            <p>
              {authed
                ? `已登录：${session?.user}${session?.source === "env" ? "（环境变量账号）" : ""}`
                : "修改邮件告警、站点信息与探测间隔"}
            </p>
          </div>
          <button type="button" className="set-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="set-body">
          {loading ? <p className="set-hint">加载中…</p> : null}

          {!loading && needsAdmin ? (
            <div className="set-empty">
              <h3>还没有管理员账号</h3>
              <p>在服务器上执行一次下面的命令，拿到随机密码后再回来登录：</p>
              <code>docker compose exec fnos-monitor node scripts/set-admin.mjs</code>
              <p className="set-hint">非容器部署把命令换成 <code>node scripts/set-admin.mjs</code>。</p>
            </div>
          ) : null}

          {!loading && !needsAdmin && session && !authed ? (
            <form className="set-login" onSubmit={submitLogin}>
              <p className="set-hint">
                公网页面默认隐藏探测目标与错误详情；登录后能看到完整数据，并可修改设置。
              </p>
              <label className="set-field">
                <span>用户名</span>
                <input
                  value={login.user}
                  autoComplete="username"
                  onChange={(event) => setLogin({ ...login, user: event.target.value })}
                />
              </label>
              <label className="set-field">
                <span>密码</span>
                <input
                  type="password"
                  value={login.password}
                  autoComplete="current-password"
                  onChange={(event) => setLogin({ ...login, password: event.target.value })}
                />
              </label>
              <button className="set-btn set-btn-primary" disabled={busy === "login"}>
                {busy === "login" ? "登录中…" : "登录"}
              </button>
            </form>
          ) : null}

          {authed && form ? (
            <form id="settings-form" onSubmit={save}>
              <section className="set-section">
                <div className="set-section-title">
                  <h3>邮件告警</h3>
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) => update({ enabled: event.target.checked })}
                    />
                    <span>{form.enabled ? "已启用" : "已关闭"}</span>
                  </label>
                </div>
                <p className="set-hint">
                  服务异常 / 恢复 / 长时间未恢复时发信。{settings?.envManaged.smtp ? "环境变量里也有 SMTP 配置，保存后以这里为准。" : ""}
                </p>
                <div className="set-grid">
                  <label className="set-field set-span-2">
                    <span>SMTP 服务器</span>
                    <input
                      placeholder="smtp.qq.com"
                      value={form.host}
                      onChange={(event) => update({ host: event.target.value })}
                    />
                  </label>
                  <label className="set-field">
                    <span>端口</span>
                    <input
                      inputMode="numeric"
                      value={form.port}
                      onChange={(event) => {
                        const port = event.target.value;
                        update({ port, secure: port.trim() === "465" });
                      }}
                    />
                  </label>
                  <div className="set-field set-check">
                    <span>加密</span>
                    <label className="set-inline">
                      <input
                        type="checkbox"
                        checked={form.secure}
                        onChange={(event) => update({ secure: event.target.checked })}
                      />
                      <span>SSL/TLS（465；关闭则用 STARTTLS / 587）</span>
                    </label>
                  </div>
                  <label className="set-field">
                    <span>用户名</span>
                    <input
                      autoComplete="off"
                      value={form.user}
                      onChange={(event) => update({ user: event.target.value })}
                    />
                  </label>
                  <label className="set-field">
                    <span>密码 / 授权码</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder={settings?.alerts.hasPass ? "已保存，留空不修改" : "QQ 邮箱填授权码"}
                      value={form.pass}
                      onChange={(event) => update({ pass: event.target.value })}
                    />
                  </label>
                  <label className="set-field set-span-2">
                    <span>发件人</span>
                    <input
                      placeholder="fnOS 监控 <you@qq.com>"
                      value={form.from}
                      onChange={(event) => update({ from: event.target.value })}
                    />
                  </label>
                  <label className="set-field set-span-2">
                    <span>收件人（逗号分隔，最多 10 个）</span>
                    <input
                      placeholder="a@example.com, b@example.com"
                      value={form.to}
                      onChange={(event) => update({ to: event.target.value })}
                    />
                  </label>
                  <label className="set-field">
                    <span>重复提醒（分钟，0 = 不重复）</span>
                    <input
                      inputMode="numeric"
                      value={form.repeat}
                      onChange={(event) => update({ repeat: event.target.value })}
                    />
                  </label>
                  <label className="set-field">
                    <span>状态页地址（邮件里附带）</span>
                    <input
                      placeholder="https://status.example.com"
                      value={form.url}
                      onChange={(event) => update({ url: event.target.value })}
                    />
                  </label>
                </div>
                <div className="set-actions">
                  <button type="button" className="set-btn" onClick={sendTest} disabled={busy === "test"}>
                    {busy === "test" ? "发送中…" : "发送测试邮件"}
                  </button>
                </div>
              </section>

              <section className="set-section">
                <div className="set-section-title">
                  <h3>站点与探测</h3>
                </div>
                <div className="set-grid">
                  <label className="set-field">
                    <span>站点名称</span>
                    <input value={form.siteName} onChange={(event) => update({ siteName: event.target.value })} />
                  </label>
                  <label className="set-field">
                    <span>探测间隔（秒，10–3600）</span>
                    <input
                      inputMode="numeric"
                      value={form.interval}
                      onChange={(event) => update({ interval: event.target.value })}
                    />
                  </label>
                  <label className="set-field set-span-2">
                    <span>站点描述</span>
                    <input value={form.siteDesc} onChange={(event) => update({ siteDesc: event.target.value })} />
                  </label>
                </div>
              </section>

              <section className="set-section">
                <div className="set-section-title">
                  <h3>管理员</h3>
                </div>
                {session?.source === "env" ? (
                  <p className="set-hint">当前账号来自 STATUS_USER / STATUS_PASSWORD 环境变量，密码只能改环境变量后重启。</p>
                ) : (
                  <div className="set-grid">
                    <label className="set-field">
                      <span>当前密码</span>
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={passwords.current}
                        onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
                      />
                    </label>
                    <label className="set-field">
                      <span>新密码（至少 8 位）</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={passwords.next}
                        onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}
                      />
                    </label>
                    <div className="set-actions set-span-2">
                      <button
                        type="button"
                        className="set-btn"
                        onClick={changePassword}
                        disabled={busy === "password" || !passwords.current || !passwords.next}
                      >
                        {busy === "password" ? "保存中…" : "修改密码"}
                      </button>
                      <button type="button" className="set-btn set-btn-ghost" onClick={logout}>
                        退出登录
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </form>
          ) : null}

          {!loading && error && !authed && !needsAdmin ? <p className="set-error">{error}</p> : null}
        </div>

        {authed && form ? (
          <footer className="set-foot">
            <div className="set-msg">
              {error ? <span className="set-error">{error}</span> : null}
              {notice ? <span className="set-ok">{notice}</span> : null}
            </div>
            <div className="set-actions">
              <button type="button" className="set-btn set-btn-ghost" onClick={onClose}>
                关闭
              </button>
              <button type="submit" form="settings-form" className="set-btn set-btn-primary" disabled={busy === "save"}>
                {busy === "save" ? "保存中…" : "保存设置"}
              </button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
