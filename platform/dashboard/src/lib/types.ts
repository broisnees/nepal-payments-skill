// Response shapes the dashboard needs that platform/shared/src/api.ts does not define yet.
// Kept here, small, until they move to @paynp/shared.
import type { Role } from "@paynp/shared";

export interface Member {
  user_id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: number;
}
export interface Invite {
  id: string;
  email: string;
  role: Role;
  expires_at: number;
}
/** GET /api/pats */
export interface Pat {
  id: string;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
  current?: boolean;
}
/** POST /api/projects/:p/test-payment (the synthetic trace `paynp test` sends, always test env) */
export interface TestPaymentResult {
  attempt_id: string;
  env?: "test";
  accepted?: number;
}
/** GET /api/me adds the daily digest preference to the shared Me shape. */
export interface MeUser {
  id: string;
  email: string;
  name: string | null;
  digest?: boolean;
}
/** Incidents carry the rule type and, for per-payment rules, the payment. */
export interface IncidentExtra {
  rule_type?: string;
  attempt_id?: string | null;
  env?: "test" | "live" | null;
}
