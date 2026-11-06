/**
 * Structured JSON-lines logger.
 *
 * - Writes to stderr by default, so it is safe inside the stdio MCP server
 *   (stdout there is reserved for JSON-RPC).
 * - Masks credential-like fields before anything is serialized, so callers
 *   cannot accidentally log an Authorization header or API key.
 * - Tests can capture output with `setLogSink` and silence it with LOG_LEVEL=silent.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
type Sink = (line: string) => void;

const LEVELS: Record<LogLevel | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SENSITIVE_KEY = /authorization|api[-_]?key|secret|password|token|cookie/i;

let sink: Sink = (line) => process.stderr.write(line + "\n");
let minLevel = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;

export function setLogSink(next: Sink | null): void {
  sink = next ?? ((line) => process.stderr.write(line + "\n"));
}

export function setLogLevel(level: LogLevel | "silent"): void {
  minLevel = LEVELS[level];
}

/** Recursively replaces values of credential-like keys with "[MASKED]". */
export function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[MASKED]" : maskSecrets(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(service: string): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < minLevel) return;
    const entry = { ts: new Date().toISOString(), level, service, msg, ...(maskSecrets(fields ?? {}) as object) };
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
