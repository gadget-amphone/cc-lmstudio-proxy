import { expect, test } from "bun:test";

import { loadDotEnvFile, loadEnvironment } from "../src/env.ts";
import { removeFileIfExists, tempFilePath } from "./helpers.ts";

test("loadDotEnvFile parses .env values", async () => {
  const filePath = tempFilePath("claude-proxy-env-", ".env");

  await Bun.write(
    filePath,
    [
      "# comment",
      "UPSTREAM_BASE_URL=http://127.0.0.1:1234",
      "LOG_PRETTY=true",
      'QUOTED_VALUE="hello world"',
      "EXPORTED=value",
      "export PROXY_PORT=9100",
    ].join("\n"),
  );

  try {
    expect(await loadDotEnvFile(filePath)).toEqual({
      UPSTREAM_BASE_URL: "http://127.0.0.1:1234",
      LOG_PRETTY: "true",
      QUOTED_VALUE: "hello world",
      EXPORTED: "value",
      PROXY_PORT: "9100",
    });
  } finally {
    await removeFileIfExists(filePath);
  }
});

test("loadEnvironment lets base env override .env values", async () => {
  const filePath = tempFilePath("claude-proxy-env-", ".env");

  await Bun.write(filePath, "UPSTREAM_BASE_URL=http://127.0.0.1:1234\nPROXY_PORT=9000\n");

  try {
    expect(
      await loadEnvironment(
        {
          PROXY_PORT: "9200",
          LOG_PRETTY: "true",
        },
        filePath,
      ),
    ).toEqual({
      UPSTREAM_BASE_URL: "http://127.0.0.1:1234",
      PROXY_PORT: "9200",
      LOG_PRETTY: "true",
    });
  } finally {
    await removeFileIfExists(filePath);
  }
});

test("loadDotEnvFile returns empty when file does not exist", async () => {
  const filePath = tempFilePath("claude-proxy-env-missing-", ".env");
  expect(await loadDotEnvFile(filePath)).toEqual({});
});

test("loadDotEnvFile throws on invalid entry without equals sign", async () => {
  const filePath = tempFilePath("claude-proxy-env-bad-", ".env");
  await Bun.write(filePath, "INVALID_LINE\n");

  try {
    await expect(loadDotEnvFile(filePath)).rejects.toThrow("Invalid .env entry at line 1");
  } finally {
    await removeFileIfExists(filePath);
  }
});

test("loadDotEnvFile throws on invalid key", async () => {
  const filePath = tempFilePath("claude-proxy-env-badkey-", ".env");
  await Bun.write(filePath, "123-BAD=value\n");

  try {
    await expect(loadDotEnvFile(filePath)).rejects.toThrow("Invalid .env key at line 1");
  } finally {
    await removeFileIfExists(filePath);
  }
});

test("loadDotEnvFile strips inline comments from unquoted values", async () => {
  const filePath = tempFilePath("claude-proxy-env-comment-", ".env");
  await Bun.write(filePath, "KEY=value # this is a comment\n");

  try {
    const env = await loadDotEnvFile(filePath);
    expect(env.KEY).toBe("value");
  } finally {
    await removeFileIfExists(filePath);
  }
});
