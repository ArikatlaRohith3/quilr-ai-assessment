import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HS256 JWT authentication — implemented on node:crypto so the verification
 * rules are explicit and auditable:
 *
 *  - header.alg must be exactly "HS256" (rejects "none" and RS/HS confusion)
 *  - signature compared in constant time
 *  - `exp` is REQUIRED; `nbf`/`iat` honoured with a small clock-skew allowance
 *  - `iss` / `aud` must match the gateway's configuration
 *  - `sub` must be present and `role` must be one of the known roles
 *
 * The client never learns *which* check failed (AuthError.reason is for audit logs only).
 */

export const ROLES = ["admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  sub: string;
  role: Role;
  exp: number;
}

export interface AuthConfig {
  secret: string;
  issuer: string;
  audience: string;
  clockSkewSec?: number;
}

export class AuthError extends Error {
  constructor(public readonly reason: string) {
    super("Invalid or expired token");
  }
}

export const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 4096;

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function decodeJsonPart(part: string, what: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new AuthError(`${what} is not base64url`);
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AuthError(`${what} is not a JSON object`);
  }
}

function sign(input: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header.trim());
  return match ? match[1] : null;
}

export function verifyToken(token: string, cfg: AuthConfig, nowMs = Date.now()): Principal {
  if (token.length > MAX_TOKEN_LENGTH) throw new AuthError("token too long");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");
  const [h, p, s] = parts;

  const header = decodeJsonPart(h, "header");
  if (header.alg !== "HS256") throw new AuthError(`unsupported alg ${String(header.alg)}`);

  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new AuthError("signature is not base64url");
  const expected = sign(`${h}.${p}`, cfg.secret);
  const actual = Buffer.from(s, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AuthError("bad signature");
  }

  // Only parse claims after the signature has been verified.
  const claims = decodeJsonPart(p, "payload");
  const now = Math.floor(nowMs / 1000);
  const skew = cfg.clockSkewSec ?? 30;

  if (typeof claims.exp !== "number") throw new AuthError("missing exp");
  if (now > claims.exp + skew) throw new AuthError("expired");
  if (typeof claims.nbf === "number" && now + skew < claims.nbf) throw new AuthError("not yet valid");
  if (typeof claims.iat === "number" && claims.iat > now + skew) throw new AuthError("issued in the future");
  if (claims.iss !== cfg.issuer) throw new AuthError("wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.audience)) throw new AuthError("wrong audience");
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 256) throw new AuthError("missing sub");
  if (!ROLES.includes(claims.role as Role)) throw new AuthError("unknown role");

  return { sub: claims.sub, role: claims.role as Role, exp: claims.exp };
}

/** Issues a token. Used by the mint-token CLI, the demo and tests — a real deployment would use its IdP. */
export function signToken(
  claims: { sub: string; role: string; [k: string]: unknown },
  cfg: AuthConfig,
  ttlSec = 3600,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: cfg.issuer, aud: cfg.audience, iat, exp: iat + ttlSec, ...claims }));
  return `${header}.${payload}.${b64url(sign(`${header}.${payload}`, cfg.secret))}`;
}

export function authConfigFromEnv(): AuthConfig {
  const secret = process.env.GATEWAY_JWT_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`GATEWAY_JWT_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters long`);
  }
  return {
    secret,
    issuer: process.env.GATEWAY_JWT_ISSUER ?? "quilr-auth",
    audience: process.env.GATEWAY_JWT_AUDIENCE ?? "quilr-mcp-gateway",
  };
}
