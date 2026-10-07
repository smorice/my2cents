export const BASE = "/my2cents";
const API = `${BASE}/api`;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function detail(body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d))
      return d
        .map((e: { msg?: string; loc?: string[] }) => {
          const field = e.loc?.slice(1).join(".");
          return (field ? `${field} : ` : "") + (e.msg ?? "").replace(/^Value error, /, "");
        })
        .join(" · ");
  }
  return "Erreur inattendue";
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; params?: Record<string, unknown> } = {}): Promise<T> {
  let url = API + path;
  if (opts.params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    const s = q.toString();
    if (s) url += "?" + s;
  }
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    credentials: "same-origin",
    headers: { "x-my2cents-csrf": "1", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, detail(body));
  }
  return body as T;
}

export const exportUrl = (id: string, kind: string) => `${API}/backtests/${id}/export/${kind}.csv`;
