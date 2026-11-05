// The parts of @paynp/shared the SDK needs. Imported by path so the bundler inlines exactly
// these two files (and not the error explainer); the published package has no dependencies.
export { DEFAULT_ENDPOINT } from "../../shared/src/brand.ts";
export { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, newId, validateEvent } from "../../shared/src/events.ts";
export type { EventCustomer, EventData, EventType, PaymentEvent, PaymentStatus } from "../../shared/src/events.ts";
