import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** True when the given module is the process entry point (so importing it in tests doesn't start a server). */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return !!entry && pathToFileURL(entry).href === importMetaUrl;
}

export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

/** Resolves once the server is listening; port 0 picks a free port (used by tests). */
export function listen(app: { listen: (port: number, cb: () => void) => Server }, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
