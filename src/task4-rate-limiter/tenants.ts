import { createHash } from "node:crypto";

/**
 * Tenant authentication. Clients present `Authorization: Bearer <tenant API key>`;
 * the tenant id is derived from the key and never taken from a client header,
 * so one tenant cannot spend another tenant's budget. There is no default tenant.
 *
 * Keys are kept only as SHA-256 digests and looked up by digest.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const MIN_TENANT_KEY_LENGTH = 16;

export class TenantRegistry {
  private readonly byDigest = new Map<string, string>();

  constructor(entries: Array<{ tenantId: string; apiKey: string }>) {
    for (const { tenantId, apiKey } of entries) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(tenantId)) throw new Error(`invalid tenant id "${tenantId}"`);
      if (apiKey.length < MIN_TENANT_KEY_LENGTH) throw new Error(`API key for tenant "${tenantId}" must be at least ${MIN_TENANT_KEY_LENGTH} characters`);
      this.byDigest.set(sha256(apiKey), tenantId);
    }
  }

  get size(): number {
    return this.byDigest.size;
  }

  authenticate(authorizationHeader: string | undefined): string | null {
    const match = /^Bearer (\S+)$/.exec(authorizationHeader?.trim() ?? "");
    if (!match) return null;
    return this.byDigest.get(sha256(match[1])) ?? null;
  }

  /** TENANT_API_KEYS="tenant-a:key-a,tenant-b:key-b" */
  static fromEnv(value = process.env.TENANT_API_KEYS ?? ""): TenantRegistry {
    const entries = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf(":");
        if (i <= 0) throw new Error("TENANT_API_KEYS entries must look like tenantId:apiKey");
        return { tenantId: pair.slice(0, i), apiKey: pair.slice(i + 1) };
      });
    return new TenantRegistry(entries);
  }
}
