const DEFAULT_TMP_DIR = (Bun.env.TMPDIR ?? "/tmp").replace(/\/$/, "");

export function tempFilePath(prefix: string, extension = ""): string {
  return `${DEFAULT_TMP_DIR}/${prefix}${crypto.randomUUID()}${extension}`;
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  const file = Bun.file(filePath);
  if (await file.exists()) {
    await file.unlink();
  }
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
