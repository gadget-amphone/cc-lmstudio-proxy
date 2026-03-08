import { resolvePath } from "./path.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_LOG_BODY_MAX_BYTES = 256 * 1024;
const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = 255; // Bun max: 255
const MAX_BUN_IDLE_TIMEOUT_SECONDS = 255;

export interface EnvironmentMap {
  [key: string]: string | undefined;
}

export interface ProxyConfig {
  host: string;
  port: number;
  upstreamBaseUrl: URL;
  requestTimeoutMs: number;
  serverIdleTimeoutSeconds: number;
  logBodyMaxBytes: number;
  prettyLogs: boolean;
  logFile?: string;
}

export interface PublicProxyConfig {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  requestTimeoutMs: number;
  logBodyMaxBytes: number;
  prettyLogs: boolean;
  logFile?: string;
}

function parsePositiveInteger(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function loadConfig(env: EnvironmentMap = Bun.env): ProxyConfig {
  const rawUpstreamBaseUrl = parseOptionalString(env.UPSTREAM_BASE_URL);
  if (!rawUpstreamBaseUrl) {
    throw new Error("UPSTREAM_BASE_URL is required");
  }

  let upstreamBaseUrl: URL;
  try {
    upstreamBaseUrl = new URL(rawUpstreamBaseUrl);
  } catch (error) {
    throw new Error(
      `UPSTREAM_BASE_URL must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!["http:", "https:"].includes(upstreamBaseUrl.protocol)) {
    throw new Error("UPSTREAM_BASE_URL must use http or https");
  }

  const logFile = parseOptionalString(env.LOG_FILE);

  return {
    host: parseOptionalString(env.PROXY_HOST) ?? DEFAULT_HOST,
    port: parsePositiveInteger(env.PROXY_PORT, "PROXY_PORT", DEFAULT_PORT),
    upstreamBaseUrl,
    requestTimeoutMs: parsePositiveInteger(
      env.REQUEST_TIMEOUT_MS,
      "REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    serverIdleTimeoutSeconds: Math.min(
      parsePositiveInteger(
        env.SERVER_IDLE_TIMEOUT_SECONDS,
        "SERVER_IDLE_TIMEOUT_SECONDS",
        DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
      ),
      MAX_BUN_IDLE_TIMEOUT_SECONDS,
    ),
    logBodyMaxBytes: parsePositiveInteger(
      env.LOG_BODY_MAX_BYTES,
      "LOG_BODY_MAX_BYTES",
      DEFAULT_LOG_BODY_MAX_BYTES,
    ),
    prettyLogs: parseBoolean(env.LOG_PRETTY, false),
    logFile: logFile ? resolvePath(logFile) : undefined,
  };
}

export function publicConfig(config: ProxyConfig): PublicProxyConfig {
  return {
    host: config.host,
    port: config.port,
    upstreamBaseUrl: config.upstreamBaseUrl.toString(),
    requestTimeoutMs: config.requestTimeoutMs,
    serverIdleTimeoutSeconds: config.serverIdleTimeoutSeconds,
    logBodyMaxBytes: config.logBodyMaxBytes,
    prettyLogs: config.prettyLogs,
    logFile: config.logFile,
  };
}
