// Membership and role checks. Not being a member reads as 404 so ids do not leak; a low role is 403.
import { newId, type Role } from "@paynp/shared";
import type { Context } from "hono";
import { ROLE_RANK, type AppEnv, type ProjectRow } from "../types.ts";
import { forbidden, notFound, now } from "./util.ts";

export async function orgRole(env: Env, orgId: string, userId: string): Promise<Role | null> {
  const r = await env.DB.prepare("SELECT role FROM members WHERE org_id = ? AND user_id = ?").bind(orgId, userId).first<{ role: Role }>();
  return r?.role ?? null;
}

export async function requireOrg(c: Context<AppEnv>, orgId: string, min: Role): Promise<Role> {
  const role = await orgRole(c.env, orgId, c.get("user").id);
  if (!role) throw notFound("org");
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw forbidden(`needs ${min} role`);
  return role;
}

export async function requireProject(c: Context<AppEnv>, projectId: string, min: Role): Promise<{ project: ProjectRow; role: Role }> {
  const row = await c.env.DB.prepare("SELECT p.*, m.role FROM projects p JOIN members m ON m.org_id = p.org_id AND m.user_id = ? WHERE p.id = ?")
    .bind(c.get("user").id, projectId)
    .first<ProjectRow & { role: Role }>();
  if (!row) throw notFound("project");
  if (ROLE_RANK[row.role] < ROLE_RANK[min]) throw forbidden(`needs ${min} role`);
  const { role, ...project } = row;
  return { project, role };
}

export function audit(env: Env, orgId: string, userId: string | null, action: string, target: string | null, meta?: Record<string, unknown>): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO audit_log (id, org_id, user_id, action, target, at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
    newId("aud"),
    orgId,
    userId,
    action,
    target,
    now(),
    meta ? JSON.stringify(meta) : null,
  );
}
