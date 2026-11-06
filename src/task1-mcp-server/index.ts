import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// All debug/log output goes to stderr — stdout is reserved for JSON-RPC
const log = (...args: unknown[]) => process.stderr.write(`[mcp-server] ${args.join(" ")}\n`);

const server = new McpServer({
  name: "quilr-mcp-server",
  version: "1.0.0",
});

// Tool 1: get_customer_record
server.tool(
  "get_customer_record",
  "Retrieve a customer record by ID",
  {
    customer_id: z
      .string()
      .regex(/^CUST-\d{5}$/, "customer_id must match format CUST-XXXXX (e.g. CUST-00123)"),
  },
  async ({ customer_id }) => {
    log(`get_customer_record called with customer_id=${customer_id}`);

    // Mock customer data
    const record = {
      customer_id,
      name: "Jane Doe",
      email: "jane.doe@example.com",
      account_status: "active",
      created_at: "2023-01-15T10:00:00Z",
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(record, null, 2),
        },
      ],
    };
  }
);

// Tool 2: trigger_refund
server.tool(
  "trigger_refund",
  "Trigger a refund for a customer",
  {
    customer_id: z
      .string()
      .regex(/^CUST-\d{5}$/, "customer_id must match format CUST-XXXXX"),
    amount: z
      .number()
      .positive("amount must be a positive number"),
    reason: z
      .string()
      .min(10, "reason must be at least 10 characters"),
  },
  async ({ customer_id, amount, reason }) => {
    log(`trigger_refund called: customer_id=${customer_id}, amount=${amount}, reason="${reason}"`);

    const refund = {
      refund_id: `REF-${Date.now()}`,
      customer_id,
      amount,
      reason,
      status: "processed",
      processed_at: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(refund, null, 2),
        },
      ],
    };
  }
);

async function main() {
  log("Starting MCP server over stdio transport...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected and ready.");
}

main().catch((err) => {
  process.stderr.write(`[mcp-server] Fatal error: ${err}\n`);
  process.exit(1);
});
