// Projects and ingest keys.
import { KEY_PREFIX, newId, syntheticEsewaTrace, type ApiKey, type CreatedKey, type Project } from "@paynp/shared";
import { afterIngest, ingestEvents } from "../ingest.ts";
import type { Hono } from "hono";
import { audit, requireOrg, requireProject } from "../lib/access.ts";
import { HttpError, badRequest, decodeCursor, notFound, now, page, parseEnv, parseLimit, randomString, readJson, sha256Hex, slugify, str } from "../lib/util.ts";
import type { AppEnv, ProjectRow } from "../types.ts";

const toProject = (p: ProjectRow): Project => ({ id: p.id, org_id: p.org_id, name: p.name, slug: p.slug, created_at: p.created_at });

/** Deletes a project and everything under it. */
export function deleteProjectStatements(env: Env, projectId: string): D1PreparedStatement[] {
  const tables = ["api_keys", "payments", "events", "minute_stats", "alert_channels", "alert_rules", "alert_incidents"];
  return [
    env.DB.prepare("DELETE FROM notifications WHERE channel_id IN (SELECT id FROM alert_channels WHERE project_id = ?)").bind(projectId),
    ...tables.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE project_id = ?`).bind(projectId)),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
  ];
}

export function registerProjects(api: Hono<AppEnv>) {
  api.get("/orgs/:org/projects", async (c) => {
    const orgId = c.req.param("org");
    await requireOrg(c, orgId, "viewer");
    const limit = parseLimit(c.req.query("limit"));
    const cur = decodeCursor(c.req.query("cursor"));
    const rows = await c.env.DB.prepare(`SELECT * FROM projects WHERE org_id = ? ${cur ? "AND (created_at, id) > (?, ?)" : ""} ORDER BY created_at, id LIMIT ?`)
      .bind(...[orgId, ...(cur ?? []), limit + 1])
      .all<ProjectRow>();
    const p = page(rows.results, limit, (r) => [r.created_at, r.id]);
    return c.json({ items: p.items.map(toProject), next_cursor: p.next_cursor });
  });

  api.post("/orgs/:org/projects", async (c) => {
    const orgId = c.req.param("org");
    await requireOrg(c, orgId, "admin");
    const body = await readJson(c.req.raw);
    const name = str(body, "name", { required: true, max: 100 })!;
    const slug = slugify(str(body, "slug", { max: 40 }) ?? name);
    const t = now();
    const project: Project = { id: newId("prj", t), org_id: orgId, name, slug, created_at: t };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare("INSERT INTO projects (id, org_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)").bind(project.id, orgId, name, slug, t),
        audit(c.env, orgId, c.get("user").id, "project.create", project.id, { name }),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "conflict", `slug "${slug}" is taken in this org`);
      throw e;
    }
    return c.json(project, 201);
  });

  api.get("/projects/:p", async (c) => {
    const { project, role } = await requireProject(c, c.req.param("p"), "viewer");
    return c.json({ ...toProject(project), role });
  });

  api.patch("/projects/:p", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    const name = str(body, "name", { max: 100 }) ?? project.name;
    const slug = body.slug === undefined ? project.slug : slugify(str(body, "slug", { required: true, max: 40 })!);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE projects SET name = ?, slug = ? WHERE id = ?").bind(name, slug, project.id),
        audit(c.env, project.org_id, c.get("user").id, "project.update", project.id, { name, slug }),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "conflict", `slug "${slug}" is taken in this org`);
      throw e;
    }
    return c.json({ ...toProject(project), name, slug });
  });

  api.delete("/projects/:p", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "owner");
    await c.env.DB.batch([...deleteProjectStatements(c.env, project.id), audit(c.env, project.org_id, c.get("user").id, "project.delete", project.id, { name: project.name })]);
    return c.body(null, 204);
  });

  // Addition: the dashboard's "send a test payment" button. Same trace as `paynp test`, always in the test env.
  api.post("/projects/:p/test-payment", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const t = now();
    const events = syntheticEsewaTrace(t, { name: "paynp-dashboard", version: "0.1.0", lang: "ts" });
    const result = await ingestEvents(c.env, project.id, "test", events, t);
    c.executionCtx.waitUntil(afterIngest(c.env, project.id, "test", result, t));
    return c.json({ attempt_id: events[0].attempt_id, env: "test", accepted: result.accepted }, 201);
  });

  api.get("/projects/:p/keys", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const limit = parseLimit(c.req.query("limit"));
    const cur = decodeCursor(c.req.query("cursor"));
    const rows = await c.env.DB.prepare(
      `SELECT id, env, prefix, name, created_at, last_used_at, revoked_at FROM api_keys WHERE project_id = ?
       ${cur ? "AND (created_at, id) < (?, ?)" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...[project.id, ...(cur ?? []), limit + 1])
      .all<ApiKey>();
    return c.json(page(rows.results, limit, (r) => [r.created_at, r.id]));
  });

  api.post("/projects/:p/keys", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    if (body.env !== "test" && body.env !== "live") throw badRequest("env must be test or live");
    const envName = parseEnv(body.env);
    const name = str(body, "name", { max: 100 }) ?? null;
    const key = KEY_PREFIX[envName] + randomString(32);
    const t = now();
    const created: CreatedKey = { id: newId("key", t), env: envName, prefix: key.slice(0, KEY_PREFIX[envName].length + 4), name, created_at: t, last_used_at: null, revoked_at: null, key };
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO api_keys (id, project_id, env, prefix, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
        created.id,
        project.id,
        envName,
        created.prefix,
        await sha256Hex(key),
        name,
        t,
      ),
      audit(c.env, project.org_id, c.get("user").id, "key.create", created.id, { env: envName, project: project.id }),
    ]);
    return c.json(created, 201);
  });

  api.delete("/projects/:p/keys/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const id = c.req.param("id");
    const r = await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL").bind(now(), id, project.id).run();
    if (!r.meta.changes) throw notFound("key");
    await audit(c.env, project.org_id, c.get("user").id, "key.revoke", id).run();
    return c.body(null, 204);
  });
}
