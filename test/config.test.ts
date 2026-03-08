import { expect, test } from "bun:test";

import { loadConfig, publicConfig, parseCliArgs } from "../src/config.ts";
import { resolvePath } from "../src/path.ts";

test("loadConfig resolves LOG_FILE to an absolute path when --log is provided", () => {
  const cliOptions = parseCliArgs(["--log"]);
  const config = loadConfig({
    UPSTREAM_BASE_URL: "http://127.0.0.1:1234",
    LOG_FILE: "logs/proxy.log",
  }, cliOptions);

  expect(config.logFile).toBe(resolvePath("logs/proxy.log"));
});

test("loadConfig ignores LOG_FILE when --log is not provided", () => {
  const config = loadConfig({
    UPSTREAM_BASE_URL: "http://127.0.0.1:1234",
    LOG_FILE: "logs/proxy.log",
  });

  expect(config.logFile).toBeUndefined();
});

test("publicConfig includes logFile when --log is provided and LOG_FILE is set", () => {
  const cliOptions = parseCliArgs(["--log"]);
  const config = loadConfig({
    UPSTREAM_BASE_URL: "http://127.0.0.1:1234",
    LOG_FILE: "logs/proxy.log",
  }, cliOptions);

  expect(publicConfig(config)).toEqual({
    host: "127.0.0.1",
    port: 9000,
    upstreamBaseUrl: "http://127.0.0.1:1234/",
    requestTimeoutMs: 300_000,
    serverIdleTimeoutSeconds: 255,
    logBodyMaxBytes: 256 * 1024,
    prettyLogs: false,
    enableLogging: true,
    logFile: resolvePath("logs/proxy.log"),
  });
});

test("publicConfig sets enableLogging to false when --log is not provided", () => {
  const config = loadConfig({
    UPSTREAM_BASE_URL: "http://127.0.0.1:1234",
  });

  expect(config.enableLogging).toBe(false);
});

test("publicConfig sets enableLogging to true when --log is provided", () => {
  const cliOptions = parseCliArgs(["--log"]);
  const config = loadConfig({
    UPSTREAM_BASE_URL: "http://127.0.0.1:1234",
  }, cliOptions);

  expect(config.enableLogging).toBe(true);
});

test("loadConfig throws when UPSTREAM_BASE_URL is missing", () => {
  expect(() => loadConfig({})).toThrow("UPSTREAM_BASE_URL is required");
});

test("loadConfig throws when UPSTREAM_BASE_URL is not a valid URL", () => {
  expect(() => loadConfig({ UPSTREAM_BASE_URL: "not-a-url" })).toThrow(
    "UPSTREAM_BASE_URL must be an absolute URL",
  );
});

test("loadConfig throws when UPSTREAM_BASE_URL uses unsupported protocol", () => {
  expect(() => loadConfig({ UPSTREAM_BASE_URL: "ftp://example.com" })).toThrow(
    "UPSTREAM_BASE_URL must use http or https",
  );
});

test("loadConfig throws when PROXY_PORT is not a positive integer", () => {
  expect(() =>
    loadConfig({ UPSTREAM_BASE_URL: "http://127.0.0.1:1234", PROXY_PORT: "-1" }),
  ).toThrow("PROXY_PORT must be a positive integer");

  expect(() =>
    loadConfig({ UPSTREAM_BASE_URL: "http://127.0.0.1:1234", PROXY_PORT: "abc" }),
  ).toThrow("PROXY_PORT must be a positive integer");
});

test("loadConfig uses defaults when optional values are empty strings", () => {
  const config = loadConfig({
    UPSTREAM_BASE_URL: "http://127.0.0.1:1234",
    PROXY_HOST: "",
    PROXY_PORT: "",
    LOG_PRETTY: "",
    LOG_FILE: "",
  });

  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(9000);
  expect(config.prettyLogs).toBe(false);
  expect(config.logFile).toBeUndefined();
});
