// The REST API (SPEC sections 5 and 6) as the CLI uses it.
import { CSRF_HEADER } from "../../shared/src/brand.ts";
import type { ApiKey, CreatedKey, Me, Page, Project } from "../../shared/src/api.ts";
import { VERSION } from "./version.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_url: string;
  interval: number;
  expires_in: number;
}

export interface Pat {
  id: string;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
  current?: boolean;
}

export class Api {
  constructor(
    readonly endpoint: string,
    private readonly token?: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": `paynp-cli/${VERSION}` };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && path.startsWith("/api/")) headers[CSRF_HEADER] = "1";
    let res: Response;
    try {
      res = await fetch(`${this.endpoint}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new ApiError(0, "network", `could not reach ${this.endpoint}${cause ? ` (${cause})` : ""}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.ok || okStatuses.includes(res.status)) return { status: res.status, data: data as T };
    const e = (data as { error?: unknown })?.error;
    const code = typeof e === "string" ? e : typeof e === "object" && e ? String((e as { code?: unknown }).code ?? "error") : "error";
    const message = typeof e === "object" && e && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : typeof e === "string" ? e : `HTTP ${res.status}`;
    throw new ApiError(res.status, code, message);
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request<T>("GET", path)).data;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>("POST", path, body)).data;
  }
  async del(path: string): Promise<void> {
    await this.request("DELETE", path);
  }

  /** Every page of a cursor-paginated list. */
  async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page: Page<T> = await this.get<Page<T>>(`${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }

  me = () => this.get<Me>("/api/me");
  projects = (org: string) => this.all<Project>(`/api/orgs/${encodeURIComponent(org)}/projects`);
  project = (p: string) => this.get<Project>(`/api/projects/${encodeURIComponent(p)}`);
  createProject = (org: string, name: string) => this.post<Project>(`/api/orgs/${encodeURIComponent(org)}/projects`, { name });
  keys = (p: string) => this.all<ApiKey>(`/api/projects/${encodeURIComponent(p)}/keys`);
  createKey = (p: string, env: "test" | "live", name: string) => this.post<CreatedKey>(`/api/projects/${encodeURIComponent(p)}/keys`, { env, name });
  revokeKey = (p: string, id: string) => this.del(`/api/projects/${encodeURIComponent(p)}/keys/${encodeURIComponent(id)}`);
  pats = () => this.all<Pat>("/api/pats");
  revokePat = (id: string) => this.del(`/api/pats/${encodeURIComponent(id)}`);
  deviceStart = () => this.post<DeviceStart>("/auth/device", {});
  /** 200 {token} once approved, 428 while pending; anything else throws. */
  deviceToken = (device_code: string) => this.request<{ token?: string; error?: string }>("POST", "/auth/device/token", { device_code }, [428, 429]);
  logout = () => this.request("POST", "/auth/logout", {});
}
