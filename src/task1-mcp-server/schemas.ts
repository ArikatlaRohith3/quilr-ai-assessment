import { z } from "zod";

/**
 * Strict input schemas for the MCP tools (zod 4).
 *
 * - `z.strictObject` rejects unknown fields, so a caller can't smuggle extra
 *   arguments (e.g. `"approved_by": "admin"`) past validation.
 * - Messages are written without the field name; `formatZodError` prefixes the
 *   path, giving "customer_id: must match format ...".
 */

export const CUSTOMER_ID_PATTERN = /^CUST-\d{5}$/;
export const MAX_REFUND_AMOUNT = 10_000;
export const MIN_REASON_CHARS = 10;
export const MAX_REASON_LENGTH = 500;

/** At least MIN_REASON_CHARS non-whitespace characters anywhere in the string. Also emitted as JSON Schema `pattern`. */
const REASON_PATTERN = new RegExp(`(?:\\S\\s*){${MIN_REASON_CHARS}}`);

/** "is required" when the field is missing, "must be a <type>" when it has the wrong type. */
const typeError = (type: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? "is required" : `must be a ${type}`;

export const CustomerId = z
  .string({ error: typeError("string") })
  .regex(CUSTOMER_ID_PATTERN, "must match format CUST-XXXXX (exactly five digits, e.g. CUST-00123)");

export const RefundAmount = z
  // zod 4's z.number() rejects NaN and ±Infinity itself. Infinity is reachable from
  // the wire (JSON.parse("1e400") === Infinity), so the message names it explicitly.
  .number({
    error: (issue) =>
      issue.input === undefined ? "is required" : typeof issue.input === "number" ? "must be a finite number" : "must be a number",
  })
  .positive("must be greater than 0")
  .max(MAX_REFUND_AMOUNT, `must not exceed ${MAX_REFUND_AMOUNT}`)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, "must have at most 2 decimal places");

export const RefundReason = z
  .string({ error: typeError("string") })
  .trim()
  // Counts non-whitespace characters, so neither "          " nor "a         b" passes.
  .regex(REASON_PATTERN, `must contain at least ${MIN_REASON_CHARS} non-whitespace characters`)
  .max(MAX_REASON_LENGTH, `must be at most ${MAX_REASON_LENGTH} characters`);

export const GetCustomerRecordInput = z.strictObject({ customer_id: CustomerId });

export const TriggerRefundInput = z.strictObject({ customer_id: CustomerId, amount: RefundAmount, reason: RefundReason });

export type GetCustomerRecordArgs = z.infer<typeof GetCustomerRecordInput>;
export type TriggerRefundArgs = z.infer<typeof TriggerRefundInput>;

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Client-safe, structured issues: [{ field: "customer_id", message: "must match ..." }]. Never echoes the input value. */
export function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join(".") : "arguments",
    message: issue.code === "unrecognized_keys" ? `unknown field(s) ${issue.keys.join(", ")}` : issue.message,
  }));
}

/** One stable, human-readable line: "customer_id: must match ...; amount: must be greater than 0". */
export function formatZodError(error: z.ZodError): string {
  return zodIssues(error)
    .map((i) => (i.field === "arguments" ? i.message : `${i.field}: ${i.message}`))
    .join("; ");
}
