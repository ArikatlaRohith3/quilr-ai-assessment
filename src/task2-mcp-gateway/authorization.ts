import type { Principal } from "./auth.js";

/**
 * Authorization policy — deny by default.
 *
 *  - Only allowlisted JSON-RPC methods are proxied at all.
 *  - Tools whose name starts with `admin_` (case-insensitive) need role=admin.
 *  - Extra tools can be marked admin-only via ADMIN_ONLY_TOOLS (comma separated).
 */

export const ALLOWED_METHODS = new Set(["tools/list", "tools/call", "ping"]);

/** Tool names are restricted to a safe charset so tricks like " admin_x" or "admin_x​" can't dodge the prefix check. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.\-/]{1,128}$/;

export interface Decision {
  allowed: boolean;
  reason: string;
}

export interface PolicyConfig {
  adminOnlyTools?: string[];
}

export function isAdminTool(toolName: string, cfg: PolicyConfig = {}): boolean {
  const lower = toolName.toLowerCase();
  return lower.startsWith("admin_") || (cfg.adminOnlyTools ?? []).some((t) => t.toLowerCase() === lower);
}

export function authorizeToolCall(principal: Principal, toolName: string, cfg: PolicyConfig = {}): Decision {
  if (isAdminTool(toolName, cfg) && principal.role !== "admin") {
    return { allowed: false, reason: `role ${principal.role} may not call admin tool` };
  }
  return { allowed: true, reason: "policy allows" };
}

export function policyFromEnv(): PolicyConfig {
  return {
    adminOnlyTools: (process.env.ADMIN_ONLY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
