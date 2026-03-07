import { expect, test } from "bun:test";

import {
  buildUpstreamUrl,
  createProxyServer,
  headersFromIncomingRequest,
} from "../src/proxy.ts";
import type { StructuredLogEntry } from "../src/logging.ts";
import { wait } from "./helpers.ts";

interface ClaudeMessagesRequest {
  model: string;
  system: Array<{
    type: string;
    text: string;
  }>;
  messages: Array<{
    role: string;
    content: string;
  }>;
}

interface TestLogEntry {
  event: string;
  headers?: Record<string, string | string[]>;
  body?: {
    json?: unknown;
    text?: string;
  };
  status?: number;
}

type HttpServer = Bun.Server<undefined>;

function toTestLogEntry(entry: StructuredLogEntry): TestLogEntry {
  if (typeof entry.event !== "string") {
    throw new Error("Expected log entry to include an event");
  }

  return entry as unknown as TestLogEntry;
}

function startTestServer(fetchHandler: (request: Request) => Response | Promise<Response>): HttpServer {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: fetchHandler,
  });
}

async function stopServer(server: HttpServer): Promise<void> {
  await server.stop(true);
}

test("buildUpstreamUrl joins base path and request path", () => {
  const upstreamUrl = buildUpstreamUrl(
    new URL("http://127.0.0.1:1234/lmstudio"),
    "/v1/messages?stream=true",
  );

  expect(upstreamUrl.toString()).toBe("http://127.0.0.1:1234/lmstudio/v1/messages?stream=true");
});

test("headersFromIncomingRequest strips hop-by-hop headers and injects x-request-id", () => {
  const headers = headersFromIncomingRequest(
    {
      host: "127.0.0.1:9000",
      connection: "keep-alive",
      "content-length": "10",
      authorization: "Bearer secret",
      "x-trace-id": "trace-1",
    },
    "request-1",
  );

  expect(headers.has("host")).toBe(false);
  expect(headers.has("connection")).toBe(false);
  expect(headers.has("content-length")).toBe(false);
  expect(headers.get("authorization")).toBe("Bearer secret");
  expect(headers.get("x-trace-id")).toBe("trace-1");
  expect(headers.get("x-request-id")).toBe("request-1");
});

test("createProxyServer extends Bun's idle timeout for slow upstream responses", () => {
  const originalServe = Bun.serve;
  let capturedIdleTimeout: number | undefined;

  Bun.serve = ((options) => {
    capturedIdleTimeout = options.idleTimeout;

    const fakeServer = {
      hostname: "127.0.0.1",
      port: 0,
      url: new URL("http://127.0.0.1:0"),
      stop: async () => {},
    } satisfies Partial<HttpServer>;

    return fakeServer as HttpServer;
  }) as typeof Bun.serve;

  try {
    createProxyServer(
      {
        host: "127.0.0.1",
        port: 0,
        upstreamBaseUrl: new URL("http://127.0.0.1:3001"),
        requestTimeoutMs: 5_000,
        logBodyMaxBytes: 8_192,
        prettyLogs: false,
      },
      {
        log(_entry: StructuredLogEntry) {},
      },
    );

    expect(capturedIdleTimeout).toBe(60);
  } finally {
    Bun.serve = originalServe;
  }
});

test("proxy forwards JSON requests and logs redacted request plus response payloads", async () => {
  let upstreamPayload: ClaudeMessagesRequest | undefined;
  const upstream = startTestServer(async (request) => {
    upstreamPayload = (await request.json()) as ClaudeMessagesRequest;

    return Response.json({
      ok: true,
      echoed: upstreamPayload,
    });
  });
  const entries: TestLogEntry[] = [];
  const proxy = createProxyServer(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamBaseUrl: upstream.url,
      requestTimeoutMs: 5_000,
      logBodyMaxBytes: 8_192,
      prettyLogs: false,
    },
    {
      log(entry) {
        entries.push(toTestLogEntry(entry));
      },
    },
  );

  try {
    const requestPayload = {
      model: "local-model",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.71.752; cc_entrypoint=cli; cch=bb9bb;",
        },
      ],
      messages: [{ role: "user", content: "hello from claude code" }],
    };
    const response = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify(requestPayload),
    });

    expect(response.status).toBe(200);
    expect((response.headers.get("x-proxy-request-id")?.length ?? 0) > 0).toBe(true);

    const responseBody = await response.json();
    expect(upstreamPayload).toBeDefined();
    expect(upstreamPayload?.system[0]?.text).toBe(
      "x-anthropic-billing-header: cc_version=2.1.71.752; cc_entrypoint=cli; cch=00000;",
    );
    expect(responseBody).toEqual({
      ok: true,
      echoed: requestPayload,
    });

    await wait(10);

    const requestLog = entries.find((entry) => entry.event === "proxy.request");
    const responseLog = entries.find((entry) => entry.event === "proxy.response");

    expect(requestLog).toBeDefined();
    expect(responseLog).toBeDefined();
    expect(requestLog?.headers?.authorization).toBe("<redacted>");
    expect(requestLog?.body?.json).toEqual(requestPayload);
    expect(responseLog?.status).toBe(200);
    expect(responseLog?.body?.json).toEqual(responseBody);
  } finally {
    await stopServer(proxy);
    await stopServer(upstream);
  }
});

test("proxy streams upstream responses while still logging the full body", async () => {
  const upstream = startTestServer(() => {
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
          setTimeout(() => {
            controller.enqueue(encoder.encode("data: second\n\n"));
            controller.close();
          }, 5);
        },
      }),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  });
  const entries: TestLogEntry[] = [];
  const proxy = createProxyServer(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamBaseUrl: upstream.url,
      requestTimeoutMs: 5_000,
      logBodyMaxBytes: 8_192,
      prettyLogs: false,
    },
    {
      log(entry) {
        entries.push(toTestLogEntry(entry));
      },
    },
  );

  try {
    const response = await fetch(new URL("/stream", proxy.url), {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");

    await wait(10);

    const responseLog = entries.find((entry) => entry.event === "proxy.response");
    expect(responseLog).toBeDefined();
    expect(responseLog?.body?.text).toBe("data: first\n\ndata: second\n\n");
  } finally {
    await stopServer(proxy);
    await stopServer(upstream);
  }
});

test("proxy returns 504 when upstream request times out", async () => {
  const upstream = startTestServer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return new Response("too late");
  });
  const entries: TestLogEntry[] = [];
  const proxy = createProxyServer(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamBaseUrl: upstream.url,
      requestTimeoutMs: 50,
      logBodyMaxBytes: 8_192,
      prettyLogs: false,
    },
    {
      log(entry) {
        entries.push(toTestLogEntry(entry));
      },
    },
  );

  try {
    const response = await fetch(new URL("/slow", proxy.url), {
      method: "GET",
    });

    expect(response.status).toBe(504);
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.error).toBe("upstream_timeout");
    expect(body.requestId).toBeDefined();

    await wait(10);

    const errorLog = entries.find((entry) => entry.event === "proxy.error");
    expect(errorLog).toBeDefined();
  } finally {
    await stopServer(proxy);
    await stopServer(upstream);
  }
});

test("proxy returns 502 when upstream is unreachable", async () => {
  const entries: TestLogEntry[] = [];
  const proxy = createProxyServer(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamBaseUrl: new URL("http://127.0.0.1:1"),
      requestTimeoutMs: 5_000,
      logBodyMaxBytes: 8_192,
      prettyLogs: false,
    },
    {
      log(entry) {
        entries.push(toTestLogEntry(entry));
      },
    },
  );

  try {
    const response = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("upstream_error");

    await wait(10);

    const errorLog = entries.find((entry) => entry.event === "proxy.error");
    expect(errorLog).toBeDefined();
  } finally {
    await stopServer(proxy);
  }
});

test("proxy strips cache_control from messages and normalizes cch values", async () => {
  let upstreamPayload: Record<string, unknown> | undefined;
  const upstream = startTestServer(async (request) => {
    upstreamPayload = (await request.json()) as Record<string, unknown>;
    return Response.json({ ok: true });
  });
  const proxy = createProxyServer(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamBaseUrl: upstream.url,
      requestTimeoutMs: 5_000,
      logBodyMaxBytes: 8_192,
      prettyLogs: false,
    },
    { log() {} },
  );

  try {
    const requestPayload = {
      model: "local-model",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cch=aa1bb;",
        },
        { type: "text", text: "You are helpful." },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hi there!" },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "README says cch=bb9bb in the docs",
            },
            {
              type: "text",
              text: "check this",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    };
    const response = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestPayload),
    });

    expect(response.status).toBe(200);
    expect(upstreamPayload).toBeDefined();

    const upstreamMessages = upstreamPayload?.messages as Array<{
      role: string;
      content: unknown;
    }>;

    // cache_control should be stripped from the last user message
    const lastUserContent = upstreamMessages[2]?.content as Array<Record<string, unknown>>;
    expect(lastUserContent[1]).toEqual({ type: "text", text: "check this" });
    expect(lastUserContent[1]).not.toHaveProperty("cache_control");

    // cch in tool_result content should be normalized to 00000
    expect(lastUserContent[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "README says cch=00000 in the docs",
    });

    // Unaffected messages remain unchanged
    expect(upstreamMessages[0]?.content).toEqual([
      { type: "text", text: "hello" },
    ]);
  } finally {
    await stopServer(proxy);
    await stopServer(upstream);
  }
});

test("proxy restores cch only in billing header context, not in file content", async () => {
  const billingHeader = "x-anthropic-billing-header: cc_version=1; cch=00000;";
  const fileContent = "README mentions cch=00000 here";
  const upstream = startTestServer(() => {
    return Response.json({
      billing: billingHeader,
      file: fileContent,
    });
  });
  const proxy = createProxyServer(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamBaseUrl: upstream.url,
      requestTimeoutMs: 5_000,
      logBodyMaxBytes: 8_192,
      prettyLogs: false,
    },
    { log() {} },
  );

  try {
    const response = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test",
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=1; cch=abcde;",
          },
        ],
        messages: [],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { billing: string; file: string };

    // Billing header context: cch=00000 should be restored to original
    expect(body.billing).toBe("x-anthropic-billing-header: cc_version=1; cch=abcde;");
    // File content: cch=00000 should NOT be restored
    expect(body.file).toBe("README mentions cch=00000 here");
  } finally {
    await stopServer(proxy);
    await stopServer(upstream);
  }
});
