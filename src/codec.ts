export const TEXT_ENCODER = new TextEncoder();
export const TEXT_DECODER = new TextDecoder();

export const TEXTUAL_CONTENT_TYPE_MARKERS = [
  "application/json",
  "application/problem+json",
  "application/ld+json",
  "application/x-www-form-urlencoded",
  "application/xml",
  "application/javascript",
  "application/x-ndjson",
  "text/",
];

export function isTextualContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return true;
  }

  return TEXTUAL_CONTENT_TYPE_MARKERS.some((marker) => contentType.includes(marker));
}

export function isJsonContentType(contentType: string | null | undefined): boolean {
  return contentType ? contentType.includes("json") : false;
}
