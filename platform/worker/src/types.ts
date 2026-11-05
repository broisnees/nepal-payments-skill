import type { Role } from "@paynp/shared";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  digest_opt_out: number;
}

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  created_at: number;
}

export interface PaymentRow {
  project_id: string;
  env: string;
  attempt_id: string;
  order_id: string | null;
  gateway: string;
  amount_paisa: number | null;
  status: string;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  provider_ref: string | null;
  last_reason: string | null;
  last_message: string | null;
  event_count: number;
  error_count: number;
  fulfil_count: number;
  status_at: number;
  reason_at: number;
  // v2 (migrations/0002_ops.sql)
  customer_hash: string | null;
  customer_mask: string | null;
  customer_name: string | null;
  refunded_paisa: number;
  gw_env: string | null;
  fulfilled_at: number | null;
}

export interface EventRow {
  project_id: string;
  env: string;
  id: string;
  attempt_id: string;
  type: string;
  ts: number;
  received_at: number;
  gateway: string;
  status: string | null;
  duration_ms: number | null;
  data: string | null;
  order_id: string | null;
  amount_paisa: number | null;
  sdk: string | null;
}

export interface AppVars {
  user: UserRow;
  authKind: "session" | "pat";
  sessionId?: string;
  patId?: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVars };

export const ROLE_RANK: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };
