/**
 * 探针：http(s) / tcp 两种检查。
 *
 * result 形状固定：{ state: "up" | "degraded" | "down", ms, code, error }
 * - 请求失败 / 状态码不在期望内 / 响应缺少关键字 → down
 * - 成功但耗时超过 slowMs → degraded
 * - 其余 → up
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_BODY_BYTES = 64 * 1024;

function httpCheck(service) {
  const { url, method, headers, timeoutMs, bodyIncludes, allowInsecureTls, expectStatus } = service;
  const started = performance.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, error: "", ms: Math.round(performance.now() - started), ...result });
    };

    const mod = url.startsWith("https:") ? https : http;
    const req = mod.request(
      url,
      {
        method,
        headers: { "user-agent": "fnos-monitor/0.1 (+self-hosted)", ...headers },
        timeout: timeoutMs,
        rejectUnauthorized: !allowInsecureTls,
      },
      (res) => {
        const code = res.statusCode ?? 0;
        const statusOk = expectStatus ? expectStatus.includes(code) : code >= 200 && code < 400;

        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          if (!bodyIncludes || size > MAX_BODY_BYTES) return;
          size += chunk.length;
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (!statusOk) return finish({ state: "down", code, error: `HTTP ${code}` });
          if (bodyIncludes && !Buffer.concat(chunks).toString("utf8").includes(bodyIncludes)) {
            return finish({ state: "down", code, error: `响应里没有 "${bodyIncludes}"` });
          }
          finish({ state: "up", code });
        });
        res.on("error", (err) => finish({ state: "down", code, error: err.message }));
      },
    );

    req.on("timeout", () => req.destroy(new Error(`超时（>${timeoutMs}ms）`)));
    req.on("error", (err) => finish({ state: "down", error: err.message }));
    req.end();
  });
}

function tcpCheck(service) {
  const { host, port, timeoutMs } = service;
  const started = performance.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, error: "", ms: Math.round(performance.now() - started), ...result });
    };

    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      finish({ state: "up" });
      socket.destroy();
    });
    socket.on("timeout", () => {
      finish({ state: "down", error: `超时（>${timeoutMs}ms）` });
      socket.destroy();
    });
    socket.on("error", (err) => finish({ state: "down", error: err.code ?? err.message }));
  });
}

/** 成功但慢 → degraded。 */
export function classify(service, result) {
  if (result.state === "down") return result;
  if (result.ms > service.slowMs) {
    return { ...result, state: "degraded", error: `响应慢（${result.ms}ms > ${service.slowMs}ms）` };
  }
  return result;
}

export async function runCheck(service) {
  const result = service.type === "tcp" ? await tcpCheck(service) : await httpCheck(service);
  return classify(service, result);
}
