import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { GetCustomerRecordInput, TriggerRefundInput, type GetCustomerRecordArgs, type TriggerRefundArgs } from "./schemas.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mcp-server");

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition<A = any> {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: (args: A) => Promise<ToolResult>;
}

// Mock data store. A real implementation would call a CRM / billing API here.
const CUSTOMERS: Record<string, { name: string; email: string; account_status: string; created_at: string }> = {
  "CUST-00123": { name: "Jane Doe", email: "jane.doe@example.com", account_status: "active", created_at: "2023-01-15T10:00:00Z" },
  "CUST-00456": { name: "Raj Patel", email: "raj.patel@example.com", account_status: "active", created_at: "2022-08-02T09:30:00Z" },
  "CUST-00789": { name: "Ana Lima", email: "ana.lima@example.com", account_status: "suspended", created_at: "2021-03-21T17:45:00Z" },
};

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Protocol errors (bad arguments) are raised by the server as JSON-RPC -32602 before
 * a handler runs. Handlers only return `isError: true` for *business* failures on
 * valid input, e.g. a well-formed ID that doesn't exist — that's the MCP convention.
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: "get_customer_record",
    description: "Retrieve a customer record by ID (format CUST-XXXXX).",
    schema: GetCustomerRecordInput,
    handler: async ({ customer_id }: GetCustomerRecordArgs) => {
      log.info("get_customer_record", { customer_id });
      const record = CUSTOMERS[customer_id];
      if (!record) return text(`Customer ${customer_id} not found`, true);
      return text({ customer_id, ...record });
    },
  },
  {
    name: "trigger_refund",
    description: "Issue a refund to a customer. amount must be > 0 with at most 2 decimals; reason must be at least 10 characters (surrounding whitespace not counted). Unknown fields are rejected.",
    schema: TriggerRefundInput,
    handler: async ({ customer_id, amount, reason }: TriggerRefundArgs) => {
      // The reason is free text and may contain PII, so only its length is logged.
      log.info("trigger_refund", { customer_id, amount, reason_length: reason.length });
      if (!CUSTOMERS[customer_id]) return text(`Customer ${customer_id} not found`, true);
      if (CUSTOMERS[customer_id].account_status !== "active") {
        return text(`Refunds are not allowed for ${CUSTOMERS[customer_id].account_status} accounts`, true);
      }
      return text({
        refund_id: `REF-${randomUUID()}`,
        customer_id,
        amount,
        reason,
        status: "processed",
        processed_at: new Date().toISOString(),
      });
    },
  },
];
