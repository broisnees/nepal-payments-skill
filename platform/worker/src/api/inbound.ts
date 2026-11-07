// Provider connections (src/inbound). Admin only: connecting hands paynp the merchant's provider API key.
//   GET    /projects/:p/inbound           list
//   POST   /projects/:p/inbound           { env, provider, api_key } registers the webhook in the provider
//   DELETE /projects/:p/inbound/:id       deletes it in the provider, then here
import { INBOUND_PROVIDERS, INBOUND_PROVIDER_NAMES, newId, type InboundProvider } from "@paynp/shared";
import type { Hono } from "hono";
import { audit, requireProject } from "../lib/access.ts";
import { open, seal } from "../lib/crypto.ts";
import { HttpError, appOrigin, badRequest, notFound, now, parseEnv, readJson } from "../lib/util.ts";
import { ADAPTERS, inboundUrl, keyHint, toSource, type SourceRow } from "../inbound/registry.ts";
import type { AppEnv } from "../types.ts";

export function registerInbound(api: Hono<AppEnv>) {
  api.get("/projects/:p/inbound", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const envName = c.req.query("env");
    const rows = await c.env.DB.prepare(`SELECT * FROM inbound_sources WHERE project_id = ? ${envName ? "AND env = ?" : ""} ORDER BY created_at`)
      .bind(...[project.id, ...(envName ? [parseEnv(envName)] : [])])
      .all<SourceRow>();
    const origin = appOrigin(c.env, c.req.raw);
    return c.json({ items: rows.results.map((r) => toSource(r, origin)), next_cursor: null });
  });

  api.post("/projects/:p/inbound", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    const envName = parseEnv(typeof body.env === "string" ? body.env : undefined);
    const provider = body.provider as InboundProvider;
    if (!(INBOUND_PROVIDERS as readonly string[]).includes(provider)) throw badRequest(`provider must be one of: ${INBOUND_PROVIDERS.join(", ")}`);
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (!apiKey) throw badRequest("api_key is required");
    const adapter = ADAPTERS[provider];
    adapter.checkKey(apiKey, envName);

    const existing = await c.env.DB.prepare("SELECT id FROM inbound_sources WHERE project_id = ? AND env = ? AND provider = ?").bind(project.id, envName, provider).first();
    if (existing) throw new HttpError(409, "already_connected", `${INBOUND_PROVIDER_NAMES[provider]} is already connected to ${envName}; disconnect it first`);

    const id = newId("ibs");
    // Seal before calling the provider, so a missing INBOUND_ENC_KEY fails before a webhook exists there.
    const apiKeyEnc = await seal(c.env, apiKey, `${id}:api_key`);
    const origin = appOrigin(c.env, c.req.raw);
    const reg = await adapter.register(apiKey, envName, inboundUrl(origin, id), `discerns: ${project.name} (${envName})`);
    const row: SourceRow = {
      id,
      project_id: project.id,
      env: envName,
      provider,
      provider_webhook_id: reg.id,
      secret_enc: await seal(c.env, reg.secret, `${id}:secret`),
      api_key_enc: apiKeyEnc,
      api_key_hint: keyHint(apiKey),
      enabled: 1,
      last_event_at: null,
      last_error: null,
      created_at: now(),
    };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO inbound_sources (id, project_id, env, provider, provider_webhook_id, secret_enc, api_key_enc, api_key_hint, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        ).bind(row.id, row.project_id, row.env, row.provider, row.provider_webhook_id, row.secret_enc, row.api_key_enc, row.api_key_hint, row.created_at),
        audit(c.env, project.org_id, c.get("user").id, "inbound.connect", row.id, { env: envName, provider }),
      ]);
    } catch (err) {
      // Lost a race with another connect: undo the provider side so no orphan webhook keeps posting.
      await adapter.remove(apiKey, envName, reg.id).catch(() => undefined);
      throw err;
    }
    return c.json(toSource(row, origin), 201);
  });

  api.delete("/projects/:p/inbound/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await c.env.DB.prepare("SELECT * FROM inbound_sources WHERE id = ? AND project_id = ?").bind(c.req.param("id"), project.id).first<SourceRow>();
    if (!row) throw notFound("inbound source");
    // ?force=1 removes it here even when the provider call fails (revoked key); the provider then gets 410s.
    const force = c.req.query("force") === "1";
    try {
      await ADAPTERS[row.provider].remove(await open(c.env, row.api_key_enc, `${row.id}:api_key`), row.env, row.provider_webhook_id);
    } catch (err) {
      if (!force) throw err;
    }
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM inbound_sources WHERE id = ?").bind(row.id),
      audit(c.env, project.org_id, c.get("user").id, "inbound.disconnect", row.id, { env: row.env, provider: row.provider, forced: force }),
    ]);
    return c.body(null, 204);
  });
}
