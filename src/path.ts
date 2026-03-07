const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function ensureDirectoryPath(path: string): string {
  return path.endsWith("/") || path.endsWith("\\") ? path : `${path}/`;
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(path);
}

export function resolvePath(path: string, cwd = Bun.env.PWD ?? "."): string {
  if (path.startsWith("file://")) {
    return Bun.fileURLToPath(path);
  }

  if (isAbsoluteFilePath(path)) {
    return Bun.fileURLToPath(Bun.pathToFileURL(path));
  }

  return Bun.fileURLToPath(new URL(path, Bun.pathToFileURL(ensureDirectoryPath(cwd))));
}
