import { createHash } from "node:crypto";

/**
 * API-key authentication shared by the guardrail (Task 3) and the router (Task 4).
 *
 * Clients present `Authorization: Bearer <key>`; the caller's identity is derived
 * from the key, never from a client-chosen header. Keys are kept only as SHA-256
 * digests and looked up by digest, so the raw keys never sit in memory after startup.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const MIN_API_KEY_LENGTH = 16;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface ApiKeyEntry {
  id: string;
  apiKey: string;
}

export class ApiKeyRegistry {
  private readonly byDigest = new Map<string, string>();

  /** `kind` only shapes error messages ("tenant", "client"). */
  constructor(entries: ApiKeyEntry[], kind = "client") {
    for (const { id, apiKey } of entries) {
      if (!ID_PATTERN.test(id)) throw new Error(`invalid ${kind} id "${id}"`);
      if (apiKey.length < MIN_API_KEY_LENGTH) throw new Error(`API key for ${kind} "${id}" must be at least ${MIN_API_KEY_LENGTH} characters`);
      this.byDigest.set(sha256(apiKey), id);
    }
  }

  get size(): number {
    return this.byDigest.size;
  }

  /** Returns the id that owns the presented bearer key, or null. */
  authenticate(authorizationHeader: string | undefined): string | null {
    const match = /^Bearer (\S+)$/.exec(authorizationHeader?.trim() ?? "");
    if (!match) return null;
    return this.byDigest.get(sha256(match[1])) ?? null;
  }
}

/** Parses "id-a:key-a,id-b:key-b" (the format of TENANT_API_KEYS / GUARDRAIL_API_KEYS). */
export function parseKeyList(value: string, varName: string): ApiKeyEntry[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(":");
      if (i <= 0) throw new Error(`${varName} entries must look like id:apiKey`);
      return { id: pair.slice(0, i), apiKey: pair.slice(i + 1) };
    });
}
