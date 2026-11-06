import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setLogLevel, setLogSink } from "../shared/logger.js";

// Tests are quiet unless TEST_LOGS=1.
if (!process.env.TEST_LOGS) setLogLevel("silent");

export interface Running {
  url: string;
  close(): Promise<void>;
}

export async function serve(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<Running> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Captures every log line (at debug level) while `fn` runs. */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  setLogLevel("debug");
  try {
    const result = await fn();
    return { result, logs: lines.join("\n") };
  } finally {
    setLogSink(null);
    setLogLevel(process.env.TEST_LOGS ? "debug" : "silent");
  }
}

/** Small deterministic PRNG for fuzz tests (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
