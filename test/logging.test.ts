import { expect, test } from "bun:test";

import { createStructuredLogger, redactHeaders, serializeError, summarizeBuffer } from "../src/logging.ts";
import { removeFileIfExists, tempFilePath } from "./helpers.ts";

test("createStructuredLogger appends JSON lines to LOG_FILE", async () => {
  const logFile = tempFilePath("claude-proxy-log-", ".log");

  try {
    await Bun.write(
      logFile,
      `${JSON.stringify({
        timestamp: "2026-03-06T23:59:59.000Z",
        event: "proxy.existing",
      })}\n`,
    );

    const logger = createStructuredLogger({ filePath: logFile });
    logger.log({
      timestamp: "2026-03-07T00:00:00.000Z",
      event: "proxy.started",
    });
    logger.log({
      timestamp: "2026-03-07T00:00:01.000Z",
      event: "proxy.request",
      requestId: "request-1",
    });

    await logger.close?.();

    const lines = (await Bun.file(logFile).text()).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      timestamp: "2026-03-06T23:59:59.000Z",
      event: "proxy.existing",
    });
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      timestamp: "2026-03-07T00:00:00.000Z",
      event: "proxy.started",
    });
    expect(JSON.parse(lines[2] ?? "")).toEqual({
      timestamp: "2026-03-07T00:00:01.000Z",
      event: "proxy.request",
      requestId: "request-1",
    });
  } finally {
    await removeFileIfExists(logFile);
  }
});

test("createStructuredLogger falls back to stderr when custom sink throws", async () => {
  let callCount = 0;
  const stderrLines: string[] = [];
  const originalWrite = Bun.write;

  Bun.write = async (target: unknown, data: unknown) => {
    if (target === Bun.stderr && typeof data === "string") {
      stderrLines.push(data.trim());
      return data.length;
    }
    return originalWrite(target as string, data as string);
  };

  try {
    const logger = createStructuredLogger({
      sink(line: string) {
        callCount++;
        if (callCount >= 2) {
          throw new Error("sink broken");
        }
      },
    });

    logger.log({ event: "first" });
    logger.log({ event: "second" });
    logger.log({ event: "third" });
    await logger.close?.();

    // "second" triggers the error, falls back to stderr for "second" and "third"
    const stderrEvents = stderrLines
      .filter((l) => l.startsWith("{"))
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      .map((e: Record<string, unknown>) => e.event);

    expect(stderrEvents).toContain("second");
    expect(stderrEvents).toContain("third");
  } finally {
    Bun.write = originalWrite;
  }
});

test("redactHeaders masks sensitive headers", () => {
  const result = redactHeaders({
    authorization: "Bearer token",
    "x-api-key": "sk-1234",
    cookie: "session=abc",
    "content-type": "application/json",
    "x-custom": "visible",
  });

  expect(result.authorization).toBe("<redacted>");
  expect(result["x-api-key"]).toBe("<redacted>");
  expect(result.cookie).toBe("<redacted>");
  expect(result["content-type"]).toBe("application/json");
  expect(result["x-custom"]).toBe("visible");
});

test("redactHeaders works with Headers instance", () => {
  const headers = new Headers();
  headers.set("Authorization", "Bearer secret");
  headers.set("Content-Type", "text/plain");

  const result = redactHeaders(headers);
  expect(result.authorization).toBe("<redacted>");
  expect(result["content-type"]).toBe("text/plain");
});

test("summarizeBuffer truncates large bodies", () => {
  const body = new Uint8Array(1024);
  body.fill(65); // 'A'

  const summary = summarizeBuffer(body, "text/plain", 100);
  expect(summary.bytes).toBe(1024);
  expect(summary.loggedBytes).toBe(100);
  expect(summary.truncated).toBe(true);
  expect(summary.text?.length).toBe(100);
});

test("summarizeBuffer returns JSON for json content type", () => {
  const payload = JSON.stringify({ key: "value" });
  const body = new TextEncoder().encode(payload);

  const summary = summarizeBuffer(body, "application/json", 8192);
  expect(summary.json).toEqual({ key: "value" });
  expect(summary.text).toBeUndefined();
});

test("summarizeBuffer returns base64 for binary content", () => {
  const body = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

  const summary = summarizeBuffer(body, "application/octet-stream", 8192);
  expect(summary.base64).toBeDefined();
  expect(summary.text).toBeUndefined();
  expect(summary.json).toBeUndefined();
});

test("summarizeBuffer handles empty body", () => {
  const summary = summarizeBuffer(new Uint8Array(), "application/json", 8192);
  expect(summary.bytes).toBe(0);
  expect(summary.loggedBytes).toBe(0);
  expect(summary.truncated).toBe(false);
});

test("serializeError handles Error instances", () => {
  const error = new TypeError("bad input");
  const result = serializeError(error);

  expect(result.name).toBe("TypeError");
  expect(result.message).toBe("bad input");
  expect(result.stack).toBeDefined();
});

test("serializeError handles non-Error values", () => {
  expect(serializeError("string error")).toEqual({
    name: "Error",
    message: "string error",
  });

  expect(serializeError(42)).toEqual({
    name: "Error",
    message: "42",
  });
});
