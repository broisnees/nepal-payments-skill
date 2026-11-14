import type { ProviderId } from "./types.ts";

export class PaymentError extends Error {
  readonly provider: ProviderId;
  readonly code: string;
  readonly httpStatus?: number;
  readonly details?: unknown;
  constructor(
    message: string,
    provider: ProviderId,
    code: string,
    httpStatus?: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "PaymentError";
    this.provider = provider;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** The parts of an HTTP response the error helper needs (what core/http.ts returns). */
export interface FailedResponse {
  status: number;
  data: unknown;
  text: string;
}

/** First `max` characters of a response body: enough to debug, short enough to log. */
export function bodyExcerpt(text: string, max = 200): string {
  return text.slice(0, max);
}

/**
 * The ONE way adapters turn an unusable provider response into a PaymentError.
 *
 * Message: `${summary}: ${detail}`, where detail defaults to the first 200 chars of the body.
 * Code: `http_<status>` unless the provider gives something better (pass `code`).
 * httpStatus and details are always the response status and parsed body.
 */
export function responseError(
  provider: ProviderId,
  res: FailedResponse,
  summary: string,
  options: { detail?: string; code?: string } = {},
): PaymentError {
  const detail = options.detail ?? bodyExcerpt(res.text);
  const code = options.code ?? `http_${res.status}`;
  return new PaymentError(`${summary}: ${detail}`, provider, code, res.status, res.data);
}
