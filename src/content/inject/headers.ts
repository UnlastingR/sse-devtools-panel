export function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== "string" && !(input instanceof URL) && input.method) {
    return input.method.toUpperCase();
  }
  return "GET";
}

/**
 * Exact names plus common secret-bearing patterns (`*token*`, `*api-key*`, …).
 * Matches common sensitive header names only; uncommon custom names may still appear in cleartext.
 */
export const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|authentication|x-authentication|x-amz-security-token|x-goog-api-key)$|^(?:x-)?(?:api[_-]?key|auth[_-]?token|access[_-]?token|id[_-]?token|private[_-]?token|session[_-]?token|csrf[_-]?token|xsrf[_-]?token)$|(?:^|-)(?:api[_-]?key|access[_-]?token|auth[_-]?token|id[_-]?token|private[_-]?token|session[_-]?token|csrf|xsrf|secret|password)(?:-|$)/i;

/**
 * Soft ceiling for request payload text kept in the extension.
 * Normal AI bodies stay intact; only pathological sizes are clipped.
 * Display folding (Show more / Copy) is separate — see Request Source UI.
 */
export const MAX_PAYLOAD_PREVIEW = 8_000_000;

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_RE.test(name.trim());
}

export function redactHeaderValue(name: string, value: string): string {
  if (isSensitiveHeaderName(name)) return "[REDACTED]";
  return value;
}

/** Request body/query keys often use camelCase rather than HTTP header casing. */
export function isSensitiveFieldName(name: string): boolean {
  const normalized = name.trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-");
  return (
    isSensitiveHeaderName(normalized) ||
    /^(token|jwt|bearer|password|passwd|secret|credential|credentials|client-secret|refresh-token|authorization-code|access-key|private-key|session-id|session-key)$/i.test(
      normalized,
    ) ||
    /(?:^|-)(?:password|passwd|credential|secret|token|api-key|private-key)(?:-|$)/i.test(
      normalized,
    )
  );
}

function redactKeyValuePairs(value: string, includeUrlDelimiters: boolean): string {
  const pairs = includeUrlDelimiters
    ? /(^|[?&#])([^=&#?]+)=([^&#]*)/g
    : /(^|&)([^=&]+)=([^&]*)/g;
  return value.replace(pairs, (match, prefix: string, rawName: string) => {
    let name = rawName;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, " "));
    } catch {
      // Malformed escapes must not break capture.
    }
    return isSensitiveFieldName(name) ? `${prefix}${rawName}=[REDACTED]` : match;
  });
}

/** Only changes the recorded URL; the original request URL is never modified. */
export function redactCaptureUrl(url: string): string {
  const withoutCredentials = url.replace(/(\/\/)[^/?#@]+@/g, "$1[REDACTED]@");
  return redactKeyValuePairs(withoutCredentials, true);
}

/**
 * Keep stream flags and ordinary debugging fields visible, but do not store
 * obvious credentials embedded in request bodies (including nested JSON).
 */
export function redactPayloadPreview(preview: string): string {
  const trimmed = preview.trimStart();
  let sanitized = preview;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      sanitized = JSON.stringify(
        JSON.parse(preview) as unknown,
        (name: string, value: unknown) =>
          name && isSensitiveFieldName(name) ? "[REDACTED]" : value,
      );
    } catch {
      // A truncated or malformed JSON body cannot be scrubbed reliably.
      return "[unparseable JSON preview omitted]";
    }
  } else {
    sanitized = redactKeyValuePairs(preview, false);
  }
  return sanitized.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
}

export function normalizeHeaders(input?: HeadersInit): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  try {
    const headers = new Headers(input);
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = redactHeaderValue(key, value);
    });
  } catch {
    return undefined;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = redactHeaderValue(key, value);
  });
  return out;
}

export function parseRawResponseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!name) continue;
    out[name.toLowerCase()] = redactHeaderValue(name, value);
  }
  return out;
}

export function mergeHeaderMaps(
  a?: Record<string, string>,
  b?: Record<string, string>,
): Record<string, string> | undefined {
  if (!a && !b) return undefined;
  if (!a) return { ...b };
  if (!b) return { ...a };
  return { ...a, ...b };
}

export function clipPayloadText(text: string): { preview: string; truncated: boolean } {
  if (text.length <= MAX_PAYLOAD_PREVIEW) {
    return { preview: text, truncated: false };
  }
  return {
    preview: text.slice(0, MAX_PAYLOAD_PREVIEW),
    truncated: true,
  };
}

export async function payloadPreviewFromBody(
  body: BodyInit | null | undefined,
): Promise<{ preview?: string; truncated?: boolean }> {
  if (body == null) return {};
  if (typeof body === "string") {
    const clipped = clipPayloadText(body);
    return { preview: redactPayloadPreview(clipped.preview), truncated: clipped.truncated };
  }
  if (body instanceof URLSearchParams) {
    const clipped = clipPayloadText(body.toString());
    return { preview: redactPayloadPreview(clipped.preview), truncated: clipped.truncated };
  }
  if (body instanceof FormData) {
    const fields: string[] = [];
    body.forEach((value, key) => {
      if (typeof value === "string") {
        fields.push(`${key}=${value}`);
      } else {
        fields.push(`${key}=[blob:${value.type || "application/octet-stream"}]`);
      }
    });
    const clipped = clipPayloadText(fields.join("&"));
    return { preview: redactPayloadPreview(clipped.preview), truncated: clipped.truncated };
  }
  if (body instanceof Blob) {
    try {
      const text = await body.text();
      const clipped = clipPayloadText(text);
      return { preview: redactPayloadPreview(clipped.preview), truncated: clipped.truncated };
    } catch {
      return { preview: `[blob:${body.type || "application/octet-stream"}]` };
    }
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body.byteLength;
    return { preview: `[binary:${bytes} bytes]` };
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return { preview: "[stream body]" };
  }
  return { preview: "[payload]" };
}

export async function collectFetchRequestMeta(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{
  headers?: Record<string, string>;
  payloadPreview?: string;
  payloadTruncated?: boolean;
}> {
  let requestHeaders: Record<string, string> | undefined;
  let payloadPreview: string | undefined;
  let payloadTruncated: boolean | undefined;

  if (typeof input !== "string" && !(input instanceof URL) && input instanceof Request) {
    requestHeaders = mergeHeaderMaps(requestHeaders, normalizeHeaders(input.headers));
    const body = input.clone();
    try {
      const text = await body.text();
      if (text) {
        const clipped = clipPayloadText(text);
        payloadPreview = redactPayloadPreview(clipped.preview);
        payloadTruncated = clipped.truncated;
      }
    } catch {
      // best effort only
    }
  }

  requestHeaders = mergeHeaderMaps(requestHeaders, normalizeHeaders(init?.headers));
  if (init?.body != null) {
    const fromInit = await payloadPreviewFromBody(init.body);
    payloadPreview = fromInit.preview ?? payloadPreview;
    payloadTruncated = fromInit.truncated ?? payloadTruncated;
  }

  return { headers: requestHeaders, payloadPreview, payloadTruncated };
}

/**
 * Synchronous, non-invasive metadata collection for fetch interception.
 *
 * Do not clone/read a Request body here: doing so before the native fetch call can
 * perturb request timing and stream backpressure. Request bodies supplied via
 * `init.body` are previewed only when they can be inspected synchronously.
 */
export function collectFetchRequestMetaSync(
  input: RequestInfo | URL,
  init?: RequestInit,
): {
  headers?: Record<string, string>;
  payloadPreview?: string;
  payloadTruncated?: boolean;
} {
  let requestHeaders: Record<string, string> | undefined;
  let payloadPreview: string | undefined;
  let payloadTruncated: boolean | undefined;

  if (typeof input !== "string" && !(input instanceof URL) && input instanceof Request) {
    requestHeaders = mergeHeaderMaps(requestHeaders, normalizeHeaders(input.headers));
  }

  requestHeaders = mergeHeaderMaps(requestHeaders, normalizeHeaders(init?.headers));

  const body = init?.body;
  if (typeof body === "string") {
    const clipped = clipPayloadText(body);
    payloadPreview = redactPayloadPreview(clipped.preview);
    payloadTruncated = clipped.truncated;
  } else if (body instanceof URLSearchParams) {
    const clipped = clipPayloadText(body.toString());
    payloadPreview = redactPayloadPreview(clipped.preview);
    payloadTruncated = clipped.truncated;
  } else if (body instanceof FormData) {
    const fields: string[] = [];
    body.forEach((value, key) => {
      if (typeof value === "string") fields.push(`${key}=${value}`);
      else fields.push(`${key}=[blob:${value.type || "application/octet-stream"}]`);
    });
    const clipped = clipPayloadText(fields.join("&"));
    payloadPreview = redactPayloadPreview(clipped.preview);
    payloadTruncated = clipped.truncated;
  } else if (body instanceof Blob) {
    payloadPreview = `[blob:${body.type || "application/octet-stream"}]`;
    payloadTruncated = false;
  } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    payloadPreview = `[binary:${body.byteLength} bytes]`;
    payloadTruncated = false;
  } else if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    payloadPreview = "[stream body]";
    payloadTruncated = false;
  } else if (body != null) {
    payloadPreview = "[payload]";
    payloadTruncated = false;
  }

  return { headers: requestHeaders, payloadPreview, payloadTruncated };
}
