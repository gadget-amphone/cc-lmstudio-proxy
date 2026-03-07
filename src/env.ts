import type { EnvironmentMap } from "./config.ts";
import { resolvePath } from "./path.ts";

function parseQuotedValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  const commentIndex = value.search(/\s#/);
  if (commentIndex >= 0) {
    return value.slice(0, commentIndex).trimEnd();
  }

  return value;
}

export async function loadDotEnvFile(filePath = resolvePath(".env")): Promise<EnvironmentMap> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {};
  }

  const content = await file.text();
  const parsed: EnvironmentMap = {};
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const candidate = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const separatorIndex = candidate.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`Invalid .env entry at line ${index + 1}`);
    }

    const key = candidate.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid .env key at line ${index + 1}: ${key}`);
    }

    const rawValue = candidate.slice(separatorIndex + 1).trim();
    parsed[key] = parseQuotedValue(rawValue);
  }

  return parsed;
}

export async function loadEnvironment(
  baseEnv: EnvironmentMap = Bun.env,
  filePath?: string,
): Promise<EnvironmentMap> {
  return {
    ...(await loadDotEnvFile(filePath)),
    ...baseEnv,
  };
}
