// The types the eSewa module speaks (same contract as the blog's payments.ts).
export type PaymentStatus = "paid" | "pending" | "failed" | "canceled" | "refunded" | "not_found";
export type Start =
  | { type: "redirect"; url: string; providerRef?: string }
  | { type: "form"; action: string; fields: Record<string, string>; providerRef?: string; enctype?: "multipart/form-data" };
export interface Outcome {
  status: PaymentStatus;
  providerRef?: string;
}
export interface StartInput {
  attemptId: string;
  amountPaisa: number;
  returnUrl: string;
  description: string;
}
export interface ConfirmInput {
  attemptId: string;
  amountPaisa: number;
  providerRef: string | null;
  params: Record<string, string>;
}
export class PaymentError extends Error {}
