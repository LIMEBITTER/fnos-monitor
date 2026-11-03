/** 极简 fetch 封装：统一 JSON、错误消息与会话 cookie（同源自动携带）。 */
export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    if (data && typeof data === "object" && "error" in data) {
      const detail = (data as { error: unknown }).error;
      if (typeof detail === "string" && detail) message = detail;
    }
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}
