// WebhookSender: one Durable Object per "project:env". Ingest kicks it after queueing deliveries; it sends from
// its alarm (its own invocation, so ingest's D1 and subrequest budgets are untouched) and re-arms the alarm for
// the next retry. Alarms do not overlap, so a delivery is never sent twice at once.
import { DurableObject } from "cloudflare:workers";
import { deliverDue } from "./deliver.ts";

interface Scope {
  projectId: string;
  env: string;
}

export class WebhookSender extends DurableObject<Env> {
  async kick(projectId: string, envName: string): Promise<void> {
    await this.ctx.storage.put<Scope>("scope", { projectId, env: envName });
    const t = Date.now();
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > t) await this.ctx.storage.setAlarm(t);
  }

  async alarm(): Promise<void> {
    const scope = await this.ctx.storage.get<Scope>("scope");
    if (!scope) return;
    const next = await deliverDue(this.env, scope.projectId, scope.env);
    if (next === null) return;
    // A kick during this run may already have set an earlier alarm; keep it.
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > next) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }
}
