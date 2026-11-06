/** Error helpers shared by all services. Messages here are the ONLY text clients ever see. */

export type JsonRpcId = string | number | null;

export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Gateway-specific (implementation-defined server error range -32000..-32099). */
  UNAUTHENTICATED: -32000,
  UNAUTHORIZED_TOOL: -32001,
  DOWNSTREAM_ERROR: -32002,
  DOWNSTREAM_TIMEOUT: -32003,
} as const;

export function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/** Returns the id only if it is a valid JSON-RPC id, otherwise null (per spec). */
export function safeJsonRpcId(id: unknown): JsonRpcId {
  if (typeof id === "string" || (typeof id === "number" && Number.isFinite(id))) return id;
  return null;
}

/** HTTP gateway error body: fixed shape, never contains upstream text or stack traces. */
export function gatewayError(code: number, message: string, source: string) {
  return { error: { code, message, source } };
}
