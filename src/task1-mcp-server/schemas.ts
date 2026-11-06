import { z } from "zod";

/**
 * Strict input schemas for the MCP tools (zod 4).
 * `z.strictObject` rejects unknown fields so a caller can't smuggle extra arguments
 * (e.g. `"approved_by": "admin"`) past validation.
 */

export const CUSTOMER_ID_PATTERN = /^CUST-\d{5}$/;

/** "x is required" when the field is missing, "x must be a <type>" when it has the wrong type. */
const typeError = (field: string, type: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? `${field} is required` : `${field} must be a ${type}`;

export const CustomerId = z
  .string({ error: typeError("customer_id", "string") })
  .regex(CUSTOMER_ID_PATTERN, "customer_id must match format CUST-XXXXX (e.g. CUST-00123)");

export const MAX_REFUND_AMOUNT = 10_000;

export const RefundAmount = z
  // JSON.parse("1e400") === Infinity, so a non-finite number is reachable from the wire.
  // zod 4 rejects Infinity/NaN in z.number() itself; the message says so explicitly.
  .number({
    error: (issue) =>
      issue.input === undefined
        ? "amount is required"
        : typeof issue.input === "number"
          ? "amount must be a finite number"
          : "amount must be a number",
  })
  .positive("amount must be greater than 0")
  .max(MAX_REFUND_AMOUNT, `amount must not exceed ${MAX_REFUND_AMOUNT}`)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, "amount must have at most 2 decimal places");

export const RefundReason = z
  .string({ error: typeError("reason", "string") })
  // Trim first so "          x" (padding) can't satisfy the 10-character minimum.
  .trim()
  .min(10, "reason must be at least 10 characters (excluding surrounding whitespace)")
  .max(500, "reason must be at most 500 characters");

export const GetCustomerRecordInput = z.strictObject({ customer_id: CustomerId });

export const TriggerRefundInput = z.strictObject({ customer_id: CustomerId, amount: RefundAmount, reason: RefundReason });

export type GetCustomerRecordArgs = z.infer<typeof GetCustomerRecordInput>;
export type TriggerRefundArgs = z.infer<typeof TriggerRefundInput>;

/** Turns a ZodError into one stable, client-safe message: "customer_id: must match ...; amount: ..." */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length ? issue.path.join(".") : "arguments";
      if (issue.code === "unrecognized_keys") return `${field}: unknown field(s) ${issue.keys.join(", ")}`;
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}
