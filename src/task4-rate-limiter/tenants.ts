import { ApiKeyRegistry, MIN_API_KEY_LENGTH, parseKeyList } from "../shared/api-keys.js";

/**
 * Tenant authentication. Clients present `Authorization: Bearer <tenant API key>`;
 * the tenant id is derived from the key and never taken from a client header,
 * so one tenant cannot spend another tenant's budget. There is no default tenant.
 * (Key handling lives in shared/api-keys.ts, which the Task 3 guardrail also uses.)
 */

export const MIN_TENANT_KEY_LENGTH = MIN_API_KEY_LENGTH;

export class TenantRegistry extends ApiKeyRegistry {
  constructor(entries: Array<{ tenantId: string; apiKey: string }>) {
    super(entries.map((e) => ({ id: e.tenantId, apiKey: e.apiKey })), "tenant");
  }

  /** TENANT_API_KEYS="tenant-a:key-a,tenant-b:key-b" */
  static fromEnv(value = process.env.TENANT_API_KEYS ?? ""): TenantRegistry {
    return new TenantRegistry(parseKeyList(value, "TENANT_API_KEYS").map((e) => ({ tenantId: e.id, apiKey: e.apiKey })));
  }
}
