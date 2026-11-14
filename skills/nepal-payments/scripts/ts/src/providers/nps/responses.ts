/** Typed shapes of NPS responses, and the guards that produce them from untyped JSON. */
import { PaymentError } from "../../core/errors.ts";
import { isRecord } from "../../core/records.ts";

export interface NpsError {
  error_code: string;
  error_message: string;
}

/** Every NPS API answer is this envelope. */
export interface NpsResponse<T> {
  code: string; // "0" ok, "1" error
  message: string;
  errors: NpsError[];
  data: T;
}

/** An envelope with a `code`. `data` is typed by the caller and still read defensively. */
export function isNpsResponse<T>(value: unknown): value is NpsResponse<T> {
  return isRecord(value) && "code" in value;
}

export interface NpsInstrument {
  InstitutionName: string;
  InstrumentName: string;
  InstrumentCode: string;
  BankType: string;
  LogoUrl: string;
}

export interface NpsServiceCharge {
  Amount: string;
  CommissionType: string;
  ChargeValue: string;
  TotalChargeAmount: string;
}

/** PaymentError for an envelope with code != "0": its error messages, `nps_<first code>`. */
export function npsEnvelopeError(operation: string, r: NpsResponse<unknown>): PaymentError {
  const messages = r.errors?.map((e) => e.error_message).join("; ");
  const firstCode = r.errors?.[0]?.error_code;
  return new PaymentError(
    `NPS ${operation}: ${messages || r.message}`,
    "nps",
    firstCode ? `nps_${firstCode}` : "nps_error",
    200,
    r,
  );
}
