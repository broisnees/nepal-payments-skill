// /v1/openapi.json: the Status API described for code generators and API tools. Kept by hand next to src/api.ts.
import { GATEWAYS } from "@paynp/shared";

const state = { type: "string", enum: ["operational", "degraded", "down", "no_data"] };
const action = { type: "string", enum: ["show", "warn", "disable"] };
const nullableNumber = { type: ["number", "null"] };

const incident = {
  type: "object",
  required: ["started_at", "ended_at", "minutes", "kind", "peak_error_rate", "peak_p95_ms", "ongoing"],
  properties: {
    gateway: { type: "string" },
    started_at: { type: "integer", description: "Epoch ms" },
    ended_at: { type: "integer", description: "Epoch ms; the last bad minute so far while ongoing" },
    minutes: { type: "integer" },
    kind: { type: "string", enum: ["errors", "latency", "errors_and_latency"] },
    peak_error_rate: { type: "number" },
    peak_p95_ms: nullableNumber,
    ongoing: { type: "boolean" },
  },
};

const summary = {
  type: "object",
  required: ["gateway", "name", "state", "action", "message", "error_rate", "p95_ms", "uptime_90d_pct", "ongoing_incident", "url"],
  properties: {
    gateway: { type: "string", enum: [...GATEWAYS] },
    name: { type: "string" },
    state,
    action,
    message: { type: ["string", "null"], description: "Buyer-facing sentence when slow or down" },
    error_rate: { ...nullableNumber, description: "Share of failed checks, last 15 minutes" },
    p95_ms: { ...nullableNumber, description: "p95 response time in ms, last 15 minutes" },
    uptime_90d_pct: { ...nullableNumber, description: "Share of healthy minutes over 90 Nepal days" },
    ongoing_incident: { oneOf: [{ $ref: "#/components/schemas/Incident" }, { type: "null" }] },
    url: { type: "string", format: "uri" },
  },
};

const error = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } } },
};

const ok = (schema: object, description: string) => ({
  description,
  headers: { ETag: { schema: { type: "string" }, description: "Send back as If-None-Match for a 304" } },
  content: { "application/json": { schema } },
});
const notModified = { description: "Not modified since the ETag in If-None-Match" };
const err = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
const ifNoneMatch = { name: "If-None-Match", in: "header", required: false, schema: { type: "string" } };

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "discerns Status API",
    version: "1.0.0",
    description:
      "Availability and response times of Nepali payment gateways, from a check of each gateway's production API every minute. No authentication; responses are cached for 30 seconds. Within v1 fields are only added.",
  },
  servers: [{ url: "https://status.discerns.app" }],
  paths: {
    "/v1/status": {
      get: {
        summary: "Every gateway",
        operationId: "listStatus",
        parameters: [ifNoneMatch],
        responses: {
          "200": ok(
            {
              type: "object",
              required: ["generated_at", "window_minutes", "overall", "gateways"],
              properties: {
                generated_at: { type: "integer" },
                window_minutes: { type: "integer" },
                overall: {
                  type: "object",
                  properties: { state, operational: { type: "integer" }, degraded: { type: "integer" }, down: { type: "integer" }, no_data: { type: "integer" } },
                },
                gateways: { type: "array", items: { $ref: "#/components/schemas/GatewaySummary" } },
              },
            },
            "Current state of every gateway",
          ),
          "304": notModified,
        },
      },
    },
    "/v1/status/{gateway}": {
      get: {
        summary: "One gateway in full",
        operationId: "getGatewayStatus",
        parameters: [{ name: "gateway", in: "path", required: true, schema: { type: "string", enum: [...GATEWAYS] } }, ifNoneMatch],
        responses: {
          "200": ok({ allOf: [{ $ref: "#/components/schemas/GatewaySummary" }, { type: "object", properties: { generated_at: { type: "integer" }, detail: { type: "object" } } }] }, "The gateway with 24 h, 90 d and incident detail"),
          "304": notModified,
          "404": err("unknown_gateway"),
        },
      },
    },
    "/v1/checkout": {
      get: {
        summary: "Order a checkout's gateways by health",
        operationId: "planCheckout",
        parameters: [{ name: "gateways", in: "query", required: true, description: "Comma-separated gateway ids, up to 20", schema: { type: "string" } }, ifNoneMatch],
        responses: {
          "200": ok(
            {
              type: "object",
              required: ["generated_at", "order", "available", "gateways"],
              properties: {
                generated_at: { type: "integer" },
                order: { type: "array", items: { type: "string" } },
                available: { type: "array", items: { type: "string" } },
                gateways: { type: "array", items: { $ref: "#/components/schemas/GatewaySummary" } },
                unknown: { type: "array", items: { type: "string" } },
              },
            },
            "Healthy gateways first",
          ),
          "304": notModified,
          "400": err("missing_gateways"),
        },
      },
    },
    "/v1/incidents": {
      get: {
        summary: "Incidents, newest first",
        operationId: "listIncidents",
        parameters: [
          { name: "gateway", in: "query", required: false, schema: { type: "string", enum: [...GATEWAYS] } },
          { name: "ongoing", in: "query", required: false, schema: { type: "string", enum: ["true", "false"] } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          ifNoneMatch,
        ],
        responses: {
          "200": ok({ type: "object", properties: { generated_at: { type: "integer" }, incidents: { type: "array", items: { $ref: "#/components/schemas/Incident" } } } }, "Incidents"),
          "304": notModified,
          "400": err("bad_ongoing"),
          "404": err("unknown_gateway"),
        },
      },
    },
  },
  components: { schemas: { GatewaySummary: summary, Incident: incident, Error: error } },
};
