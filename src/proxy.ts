import { isJsonContentType, isTextualContentType, TEXT_DECODER, TEXT_ENCODER } from "./codec.ts";
import type { ProxyConfig } from "./config.ts";
import {
  redactHeaders,
  serializeError,
  summarizeBuffer,
  type StructuredLogger,
} from "./logging.ts";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const FIXED_PROMPT_CACHE_CCH = "00000";
const BILLING_HEADER_CCH_PATTERN = /(x-anthropic-billing-header:[^\n]*\bcch=)([0-9a-f]{5})(;?)/i;
const CCH_STANDALONE_PATTERN = /\bcch=([0-9a-f]{5})\b/gi;
type HttpServer = Bun.Server<undefined>;

type HeaderRecord = Record<string, string | string[] | undefined>;

interface CchRewrite {
  original: string;
  fixed: string;
}

interface BillingHeaderRewriteResult {
  body: Uint8Array;
  cchRewrite: CchRewrite | null;
}

function joinUrlPaths(basePathname: string, requestPathname: string): string {
  const normalizedBase = basePathname === "/" ? "" : basePathname.replace(/\/$/, "");
  const normalizedRequest = requestPathname.startsWith("/") ? requestPathname : `/${requestPathname}`;
  return normalizedBase ? `${normalizedBase}${normalizedRequest}` : normalizedRequest;
}

function extractIncomingPath(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function copyHeaders(
  headersLike: Headers | HeaderRecord | null | undefined,
  { includeRequestId }: { includeRequestId?: string } = {},
): Headers {
  const headers = new Headers();

  if (headersLike instanceof Headers) {
    for (const [name, value] of headersLike.entries()) {
      const lowerName = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === "host" || lowerName === "content-length") {
        continue;
      }

      headers.set(lowerName, value);
    }
  } else {
    for (const [name, rawValue] of Object.entries(headersLike ?? {})) {
      if (rawValue === undefined) {
        continue;
      }

      const lowerName = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === "host" || lowerName === "content-length") {
        continue;
      }

      if (Array.isArray(rawValue)) {
        for (const value of rawValue) {
          headers.append(lowerName, String(value));
        }
        continue;
      }

      headers.set(lowerName, String(rawValue));
    }
  }

  if (includeRequestId && !headers.has("x-request-id")) {
    headers.set("x-request-id", includeRequestId);
  }

  return headers;
}

function copyResponseHeaders(headersLike: Headers, requestId: string, cchRewrite: CchRewrite | null): Headers {
  const headers = new Headers();

  for (const [name, value] of headersLike.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }

    headers.set(name, restoreFixedCch(value, cchRewrite));
  }

  headers.set("x-proxy-request-id", requestId);
  return headers;
}

async function readWebStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function requestHasBody(method: string | undefined): boolean {
  return !["GET", "HEAD"].includes((method ?? "GET").toUpperCase());
}

function restoreFixedCch(text: string, cchRewrite: CchRewrite | null): string {
  if (!cchRewrite || typeof text !== "string") {
    return text;
  }

  return text.replaceAll(`cch=${cchRewrite.fixed}`, `cch=${cchRewrite.original}`);
}

function normalizeCchInText(text: string): string {
  return text.replace(CCH_STANDALONE_PATTERN, `cch=${FIXED_PROMPT_CACHE_CCH}`);
}

function normalizeContentBlock(block: Record<string, unknown>): Record<string, unknown> {
  const { cache_control: _, ...rest } = block;
  let changed = _ !== undefined;

  if (typeof rest.text === "string") {
    const normalized = normalizeCchInText(rest.text);
    if (normalized !== rest.text) {
      rest.text = normalized;
      changed = true;
    }
  }

  if (typeof rest.content === "string") {
    const normalized = normalizeCchInText(rest.content);
    if (normalized !== rest.content) {
      rest.content = normalized;
      changed = true;
    }
  }

  if (Array.isArray(rest.content)) {
    const normalizedContent: unknown[] = [];
    let contentChanged = false;
    for (const item of rest.content) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const normalizedItem = normalizeContentBlock(item as Record<string, unknown>);
        normalizedContent.push(normalizedItem);
        if (normalizedItem !== item) {
          contentChanged = true;
        }
      } else {
        normalizedContent.push(item);
      }
    }
    if (contentChanged) {
      rest.content = normalizedContent;
      changed = true;
    }
  }

  return changed ? rest : (block as Record<string, unknown>);
}

function normalizeMessages(
  messages: unknown[],
): { messages: unknown[]; changed: boolean } {
  let changed = false;
  const result = messages.map((msg) => {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return msg;
    }

    const message = msg as Record<string, unknown>;

    if (typeof message.content === "string") {
      const normalized = normalizeCchInText(message.content);
      if (normalized !== message.content) {
        changed = true;
        return { ...message, content: normalized };
      }
      return msg;
    }

    if (Array.isArray(message.content)) {
      const normalizedBlocks: unknown[] = [];
      let blocksChanged = false;
      for (const block of message.content) {
        if (block && typeof block === "object" && !Array.isArray(block)) {
          const normalized = normalizeContentBlock(block as Record<string, unknown>);
          normalizedBlocks.push(normalized);
          if (normalized !== block) {
            blocksChanged = true;
          }
        } else {
          normalizedBlocks.push(block);
        }
      }
      if (blocksChanged) {
        changed = true;
        return { ...message, content: normalizedBlocks };
      }
    }

    return msg;
  });

  return { messages: result, changed };
}

function rewriteRequestBillingHeaderCch(
  requestBody: Uint8Array,
  contentType: string | null | undefined,
): BillingHeaderRewriteResult {
  if (!requestBody.length || !isJsonContentType(contentType)) {
    return { body: requestBody, cchRewrite: null };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(TEXT_DECODER.decode(requestBody)) as Record<string, unknown>;
  } catch {
    return { body: requestBody, cchRewrite: null };
  }

  if (!Array.isArray(payload.system)) {
    // No system block: still normalize messages if present
    if (Array.isArray(payload.messages)) {
      const { messages: normalizedMessages, changed } = normalizeMessages(payload.messages);
      if (changed) {
        return {
          body: TEXT_ENCODER.encode(JSON.stringify({ ...payload, messages: normalizedMessages })),
          cchRewrite: null,
        };
      }
    }
    return { body: requestBody, cchRewrite: null };
  }

  let cchRewrite: CchRewrite | null = null;
  const system = payload.system.map((entry) => {
    if (
      cchRewrite ||
      !entry ||
      typeof entry !== "object" ||
      !("type" in entry) ||
      !("text" in entry) ||
      entry.type !== "text" ||
      typeof entry.text !== "string"
    ) {
      return entry;
    }

    const match = entry.text.match(BILLING_HEADER_CCH_PATTERN);
    if (!match || match[2] === FIXED_PROMPT_CACHE_CCH) {
      return entry;
    }

    cchRewrite = {
      original: match[2],
      fixed: FIXED_PROMPT_CACHE_CCH,
    };

    return {
      ...entry,
      text: entry.text.replace(
        BILLING_HEADER_CCH_PATTERN,
        `$1${FIXED_PROMPT_CACHE_CCH}$3`,
      ),
    };
  });

  const messagesResult = Array.isArray(payload.messages)
    ? normalizeMessages(payload.messages)
    : null;

  if (!cchRewrite && !messagesResult?.changed) {
    return { body: requestBody, cchRewrite: null };
  }

  const normalized: Record<string, unknown> = { ...payload };
  if (cchRewrite) {
    normalized.system = system;
  }
  if (messagesResult?.changed) {
    normalized.messages = messagesResult.messages;
  }

  return {
    body: TEXT_ENCODER.encode(JSON.stringify(normalized)),
    cchRewrite,
  };
}

function replaceInBillingHeaderContext(text: string, search: string, replacement: string): string {
  let result = "";
  let lastIndex = 0;
  let index = text.indexOf(search, lastIndex);

  while (index !== -1) {
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const linePrefix = text.slice(lineStart, index);

    if (/x-anthropic-billing-header:/i.test(linePrefix)) {
      result += text.slice(lastIndex, index) + replacement;
    } else {
      result += text.slice(lastIndex, index + search.length);
    }
    lastIndex = index + search.length;
    index = text.indexOf(search, lastIndex);
  }

  result += text.slice(lastIndex);
  return result;
}

function createFixedCchRestoreStream(cchRewrite: CchRewrite): TransformStream<string, string> {
  const search = `cch=${cchRewrite.fixed}`;
  const replace = `cch=${cchRewrite.original}`;
  const carryLength = Math.max(search.length - 1, 0);
  let carry = "";

  return new TransformStream<string, string>({
    transform(chunk: string, controller) {
      const combined = carry + chunk;
      const boundary = Math.max(0, combined.length - carryLength);
      const head = combined.slice(0, boundary);
      carry = combined.slice(boundary);

      if (head) {
        controller.enqueue(replaceInBillingHeaderContext(head, search, replace));
      }
    },
    flush(controller) {
      if (carry) {
        controller.enqueue(replaceInBillingHeaderContext(carry, search, replace));
      }
    },
  });
}

function createTextDecodeStream(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder();

  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) {
        controller.enqueue(text);
      }
    },
    flush(controller) {
      const tail = decoder.decode();
      if (tail) {
        controller.enqueue(tail);
      }
    },
  });
}

function createTextEncodeStream(): TransformStream<string, Uint8Array> {
  const encoder = new TextEncoder();

  return new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

function restoreFixedCchInResponseBody(
  stream: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  cchRewrite: CchRewrite | null,
): ReadableStream<Uint8Array> | null {
  if (!stream || !cchRewrite || !isTextualContentType(contentType)) {
    return stream;
  }

  return stream
    .pipeThrough(createTextDecodeStream())
    .pipeThrough(createFixedCchRestoreStream(cchRewrite))
    .pipeThrough(createTextEncodeStream());
}

function makeTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Upstream request exceeded ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

async function fetchWithTimeout(input: URL | string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(makeTimeoutError(timeoutMs)), timeoutMs);

  try {
    return await fetch(input, {
      ...options,
      signal: controller.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function createErrorResponse(status: number, requestId: string, error: unknown): Response {
  const payload = JSON.stringify({
    error: status === 504 ? "upstream_timeout" : "upstream_error",
    requestId,
    message: error instanceof Error ? error.message : String(error),
  });

  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(TEXT_ENCODER.encode(payload).byteLength),
    },
  });
}

async function handleProxyRequest(
  request: Request,
  config: ProxyConfig,
  logger: StructuredLogger,
): Promise<Response> {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  let upstreamUrl: URL | undefined;

  try {
    const requestBody = requestHasBody(request.method)
      ? new Uint8Array(await request.arrayBuffer())
      : new Uint8Array();
    const requestContentType = request.headers.get("content-type");
    const { body: upstreamRequestBody, cchRewrite } = rewriteRequestBillingHeaderCch(
      requestBody,
      requestContentType,
    );
    upstreamUrl = buildUpstreamUrl(config.upstreamBaseUrl, extractIncomingPath(request));

    logger.log({
      timestamp: new Date().toISOString(),
      event: "proxy.request",
      requestId,
      method: request.method,
      path: extractIncomingPath(request),
      upstreamUrl: upstreamUrl.toString(),
      headers: redactHeaders(request.headers),
      body: summarizeBuffer(
        requestBody,
        requestContentType,
        config.logBodyMaxBytes,
      ),
    });

    const upstreamResponse = await fetchWithTimeout(
      upstreamUrl,
      {
        method: request.method,
        headers: headersFromIncomingRequest(request.headers, requestId),
        body: requestHasBody(request.method) ? new Blob([new Uint8Array(upstreamRequestBody)]) : undefined,
      },
      config.requestTimeoutMs,
    );

    const responseContentType = upstreamResponse.headers.get("content-type");
    const responseBody = restoreFixedCchInResponseBody(
      upstreamResponse.body,
      responseContentType,
      cchRewrite,
    );
    const clientHeaders = copyResponseHeaders(upstreamResponse.headers, requestId, cchRewrite);

    if (!responseBody) {
      logger.log({
        timestamp: new Date().toISOString(),
        event: "proxy.response",
        requestId,
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        durationMs: Date.now() - startedAt,
        headers: redactHeaders(clientHeaders),
        body: summarizeBuffer(new Uint8Array(), responseContentType, config.logBodyMaxBytes),
      });

      return new Response(null, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: clientHeaders,
      });
    }

    const [clientStream, logStream] = responseBody.tee();
    void readWebStream(logStream)
      .then((responseBodyBytes) => {
        logger.log({
          timestamp: new Date().toISOString(),
          event: "proxy.response",
          requestId,
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          durationMs: Date.now() - startedAt,
          headers: redactHeaders(clientHeaders),
          body: summarizeBuffer(
            responseBodyBytes,
            responseContentType,
            config.logBodyMaxBytes,
          ),
        });
      })
      .catch((error) => {
        logger.log({
          timestamp: new Date().toISOString(),
          event: "proxy.log_error",
          requestId,
          stage: "response",
          error: serializeError(error),
        });
      });

    return new Response(clientStream, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: clientHeaders,
    });
  } catch (error) {
    const status = error instanceof Error && error.name === "TimeoutError" ? 504 : 502;

    logger.log({
      timestamp: new Date().toISOString(),
      event: "proxy.error",
      requestId,
      upstreamUrl: upstreamUrl?.toString() ?? null,
      durationMs: Date.now() - startedAt,
      error: serializeError(error),
    });

    return createErrorResponse(status, requestId, error);
  }
}

export function buildUpstreamUrl(upstreamBaseUrl: URL | string, incomingPath = "/"): URL {
  const baseUrl = new URL(String(upstreamBaseUrl));
  const requestUrl = new URL(incomingPath, "http://proxy.local");

  baseUrl.pathname = joinUrlPaths(baseUrl.pathname, requestUrl.pathname);
  baseUrl.search = requestUrl.search;
  return baseUrl;
}

export function headersFromIncomingRequest(
  headersLike: Headers | HeaderRecord,
  requestId: string,
): Headers {
  return copyHeaders(headersLike, { includeRequestId: requestId });
}

export function headersForClient(headersLike: Headers, requestId: string): Headers {
  return copyResponseHeaders(headersLike, requestId, null);
}

export function createProxyServer(config: ProxyConfig, logger: StructuredLogger): HttpServer {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: config.serverIdleTimeoutSeconds,
    fetch(request) {
      return handleProxyRequest(request, config, logger);
    },
    error(error) {
      logger.log({
        timestamp: new Date().toISOString(),
        event: "proxy.unhandled_error",
        error: serializeError(error),
      });
      return new Response("Internal Server Error", { status: 500 });
    },
  });
}
