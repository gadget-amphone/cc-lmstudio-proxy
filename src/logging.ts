import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { isJsonContentType, isTextualContentType, TEXT_DECODER, TEXT_ENCODER } from "./codec.ts";
import { resolvePath } from "./path.ts";

const REDACTED_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
]);

type HeaderValue = string | string[] | undefined;
type BodyLike = ArrayBuffer | Uint8Array | string | null | undefined;

export interface StructuredLogEntry {
  [key: string]: unknown;
}

export interface StructuredLogger {
  log(entry: StructuredLogEntry): void;
  close?: () => Promise<void>;
}

export interface BodySummary {
  bytes: number;
  loggedBytes: number;
  truncated: boolean;
  contentType: string | null;
  json?: unknown;
  text?: string;
  base64?: string;
}

interface LineSink {
  writeLine: (line: string) => Promise<void>;
  close?: () => Promise<void>;
}

function normalizeHeaderValue(value: unknown): HeaderValue {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (value === undefined) {
    return undefined;
  }

  return String(value);
}

function toUint8Array(value: BodyLike): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (typeof value === "string") {
    return TEXT_ENCODER.encode(value);
  }

  return new Uint8Array();
}

function createStdIoSink(target: "stdout" | "stderr"): LineSink {
  return {
    async writeLine(line: string): Promise<void> {
      await Bun.write(target === "stdout" ? Bun.stdout : Bun.stderr, `${line}\n`);
    },
  };
}

async function ensureParentPathExists(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function createAppendFileSink(resolvedFilePath: string): LineSink {
  let handlePromise: Promise<FileHandle> | undefined;

  const getHandle = () => {
    if (!handlePromise) {
      handlePromise = (async () => {
        await ensureParentPathExists(resolvedFilePath);
        return open(resolvedFilePath, "a");
      })();
    }

    return handlePromise;
  };

  return {
    async writeLine(line: string): Promise<void> {
      const handle = await getHandle();
      await handle.write(`${line}\n`);
    },
    async close(): Promise<void> {
      if (handlePromise) {
        const handle = await handlePromise;
        await handle.close();
      }
    },
  };
}

function createWriteLineSink(filePath?: string): { sink: LineSink; resolvedFilePath?: string } {
  if (!filePath) {
    return {
      sink: createStdIoSink("stdout"),
    };
  }

  const resolvedFilePath = resolvePath(filePath);
  return {
    sink: createAppendFileSink(resolvedFilePath),
    resolvedFilePath,
  };
}

async function writeSinkError(resolvedFilePath: string, error: unknown): Promise<void> {
  await Bun.write(
    Bun.stderr,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "proxy.log_sink_error",
      logFile: resolvedFilePath,
      error: serializeError(error),
    })}\n`,
  );
}

export function createStructuredLogger(
  {
    pretty = false,
    sink,
    filePath,
  }: {
    pretty?: boolean;
    sink?: (line: string) => void | Promise<void>;
    filePath?: string;
  } = {},
): StructuredLogger {
  const stderrSink = createStdIoSink("stderr");
  const primarySinkState = sink
    ? {
        sink: {
          async writeLine(line: string): Promise<void> {
            await sink(line);
          },
        } satisfies LineSink,
        resolvedFilePath: undefined,
      }
    : createWriteLineSink(filePath);
  const primarySink = primarySinkState.sink;
  let activeSink: LineSink = primarySink;
  let pendingWrite = Promise.resolve();

  return {
    log(entry: StructuredLogEntry) {
      const line = JSON.stringify(entry, null, pretty ? 2 : undefined);
      pendingWrite = pendingWrite.catch(() => undefined).then(async () => {
        try {
          await activeSink.writeLine(line);
        } catch (error) {
          activeSink = stderrSink;

          if (primarySinkState.resolvedFilePath) {
            await writeSinkError(primarySinkState.resolvedFilePath, error);
          }

          await stderrSink.writeLine(line);
        }
      });
    },
    async close(): Promise<void> {
      await pendingWrite;
      if (typeof primarySink.close === "function") {
        await primarySink.close();
      }
    },
  };
}

export function redactHeaders(
  headersLike?: Headers | Record<string, unknown> | null,
): Record<string, string | string[]> {
  const redacted: Record<string, string | string[]> = {};

  if (headersLike instanceof Headers) {
    for (const [name, value] of headersLike.entries()) {
      redacted[name] = REDACTED_HEADER_NAMES.has(name) ? "<redacted>" : value;
    }

    return redacted;
  }

  for (const [rawName, rawValue] of Object.entries(headersLike ?? {})) {
    if (rawValue === undefined) {
      continue;
    }

    const name = rawName.toLowerCase();
    const normalizedValue = normalizeHeaderValue(rawValue);
    if (normalizedValue !== undefined) {
      redacted[name] = REDACTED_HEADER_NAMES.has(name) ? "<redacted>" : normalizedValue;
    }
  }

  return redacted;
}

export function summarizeBuffer(
  buffer: BodyLike,
  contentType: string | null | undefined,
  maxBytes: number,
): BodySummary {
  const body = toUint8Array(buffer);
  const loggedBytes = Math.min(body.length, maxBytes);
  const preview = body.slice(0, loggedBytes);
  const summary: BodySummary = {
    bytes: body.length,
    loggedBytes,
    truncated: body.length > maxBytes,
    contentType: contentType ?? null,
  };

  if (preview.length === 0) {
    return summary;
  }

  if (isTextualContentType(contentType)) {
    const text = TEXT_DECODER.decode(preview);

    if (isJsonContentType(contentType) && !summary.truncated) {
      try {
        summary.json = JSON.parse(text);
        return summary;
      } catch {
        // Fall through to raw text when the body is not valid JSON.
      }
    }

    summary.text = text;
    return summary;
  }

  summary.base64 = preview.toBase64();
  return summary;
}

export function serializeError(error: unknown): Record<string, string | undefined> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}
