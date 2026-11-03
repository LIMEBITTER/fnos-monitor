import { useEffect } from "react";
import { useStatus, useTheme } from "./lib/hooks";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { ServiceCard } from "./components/ServiceCard";
import { Incidents } from "./components/Incidents";
import { Calendar, Legend } from "./components/Calendar";
import { Footer } from "./components/Footer";

export default function App() {
  const { status, connected, error } = useStatus();
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    if (status) document.title = `${status.site.name} · 运行状态`;
  }, [status]);

  return (
    <div className="app">
      <div className="backdrop" aria-hidden="true">
        <div className="blob blob-a" />
        <div className="blob blob-b" />
        <div className="blob blob-c" />
        <div className="grid-overlay" />
      </div>

      {!status ? (
        <BootState error={error} />
      ) : (
        <>
          <Header
            site={status.site}
            connected={connected}
            theme={theme}
            publicView={status.meta.publicView}
            onToggleTheme={toggleTheme}
          />

          <main className="page">
            <Hero status={status} />

            <section className="section" aria-labelledby="services-title">
              <div className="section-head">
                <h2 id="services-title">系统状态</h2>
                <span className="section-sub">
                  {status.services.length} 个服务 · 每 {status.meta.intervalSeconds} 秒探测
                </span>
                <Legend />
              </div>
              <div className="cards">
                {status.services.map((service, index) => (
                  <ServiceCard key={service.id} service={service} index={index} />
                ))}
              </div>
            </section>

            <div className="split">
              <Incidents incidents={status.incidents} />
              <Calendar calendar={status.calendar} />
            </div>
          </main>

          <Footer meta={status.meta} site={status.site} />
        </>
      )}
    </div>
  );
}

function BootState({ error }: { error: string | null }) {
  if (error) {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className="boot-emoji" aria-hidden="true">
            ⚠
          </span>
          <h1>暂时连不上状态服务</h1>
          <p>
            {error}
            <br />
            请确认 <code>npm start</code> 或容器仍在运行，然后刷新页面。
          </p>
          <button type="button" className="boot-retry" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="boot">
      <div className="boot-skeleton">
        <div className="sk sk-pill" />
        <div className="sk sk-title" />
        <div className="sk sk-sub" />
        <div className="sk-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="sk sk-card" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
