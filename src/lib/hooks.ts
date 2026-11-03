import { useEffect, useRef, useState } from "react";
import type { StatusPayload } from "../types";

/**
 * 首屏拉一次 /api/status，然后靠 SSE 实时更新；SSE 断了就退回 15s 轮询。
 */
export function useStatus() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let source: EventSource | null = null;
    let poll = 0;

    const load = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as StatusPayload;
        if (!mounted.current) return;
        setStatus(data);
        setError(null);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void load();

    try {
      source = new EventSource("/events");
      source.addEventListener("status", (event) => {
        if (!mounted.current) return;
        try {
          setStatus(JSON.parse((event as MessageEvent<string>).data) as StatusPayload);
          setConnected(true);
          setError(null);
        } catch {
          /* 单帧解析失败就等下一次 */
        }
      });
      source.onopen = () => mounted.current && setConnected(true);
      source.onerror = () => mounted.current && setConnected(false);
    } catch {
      setConnected(false);
    }

    poll = window.setInterval(load, 15000);

    return () => {
      mounted.current = false;
      source?.close();
      window.clearInterval(poll);
    };
  }, []);

  return { status, connected, error };
}

export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("fnm-theme");
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("fnm-theme", theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))] as const;
}

/** 数字从 0 涨到目标值，给可用率用。 */
export function useCountUp(value: number | null, duration = 900) {
  const [display, setDisplay] = useState(value ?? 0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (value === null) return;
    const from = fromRef.current;
    const start = performance.now();
    let frame = 0;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
      else fromRef.current = value;
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return value === null ? null : display;
}
