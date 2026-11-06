/**
 * Dev helper: mint a signed gateway token.
 *   npm run token -- admin [subject] [ttlSeconds]
 * Requires GATEWAY_JWT_SECRET (same value the gateway uses). In production tokens come from your IdP.
 */
import { ROLES, authConfigFromEnv, signToken } from "./auth.js";

const [role = "viewer", sub = `dev-${role}`, ttl = "3600"] = process.argv.slice(2);
if (!ROLES.includes(role as (typeof ROLES)[number])) {
  process.stderr.write(`role must be one of: ${ROLES.join(", ")}\n`);
  process.exit(1);
}
try {
  process.stdout.write(signToken({ sub, role }, authConfigFromEnv(), Number(ttl)) + "\n");
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
