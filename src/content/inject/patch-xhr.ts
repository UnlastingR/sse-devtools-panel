import { classifyHttpStatus } from "../../shared/stream-close";
import type { StreamCloseReason, StreamTransport } from "../../shared/types";
import { guessStreamKindFromRequest, resolveStreamKind } from "./detect";
import {
  clipPayloadText,
  parseRawResponseHeaders,
  redactCaptureUrl,
  redactHeaderValue,
  redactPayloadPreview,
} from "./headers";
import type { PostChunk, PostDiscard, PostEnd, PostError, PostStart } from "./types";

/**
 * Capture incremental XHR text bodies for SSE / NDJSON responses.
 * Only observes readyState progression; does not alter request/response for the page.
 */
export function patchXhr(
  nextId: () => string,
  postStart: PostStart,
  postChunk: PostChunk,
  postEnd: PostEnd,
  postError: PostError,
  postDiscard: PostDiscard,
): () => void {
  const OriginalXHR = window.XMLHttpRequest;
  let active = true;

  function instrumentXhr(xhr: XMLHttpRequest): XMLHttpRequest {
    let method = "GET";
    let url = "";
    const requestHeaders: Record<string, string> = {};
    let requestPayloadPreview: string | undefined;
    let requestPayloadTruncated: boolean | undefined;
    let requestId: string | null = null;
    let startedAt: number | undefined;
    let announced = false;
    let captured = false;
    let finished = false;
    let lastLen = 0;

    const originalOpen = xhr.open.bind(xhr);
    xhr.open = ((...args: Parameters<XMLHttpRequest["open"]>) => {
      const result = originalOpen(...args);
      method = String(args[0] ?? "GET").toUpperCase();
      url = String(args[1] ?? "");
      return result;
    }) as XMLHttpRequest["open"];

    const originalSetRequestHeader = xhr.setRequestHeader.bind(xhr);
    xhr.setRequestHeader = ((name: string, value: string) => {
      const result = originalSetRequestHeader(name, value);
      requestHeaders[name.toLowerCase()] = redactHeaderValue(name, String(value));
      return result;
    }) as XMLHttpRequest["setRequestHeader"];

    const originalSend = xhr.send.bind(xhr);
    xhr.send = ((body?: Document | XMLHttpRequestBodyInit | null) => {
      const sentAt = Date.now();
      const result = originalSend(body);
      if (!active) return result;

      if (body == null) {
        requestPayloadPreview = undefined;
        requestPayloadTruncated = undefined;
      } else if (typeof body === "string") {
        const clipped = clipPayloadText(body);
        requestPayloadPreview = redactPayloadPreview(clipped.preview);
        requestPayloadTruncated = clipped.truncated;
      } else if (body instanceof URLSearchParams) {
        const clipped = clipPayloadText(body.toString());
        requestPayloadPreview = redactPayloadPreview(clipped.preview);
        requestPayloadTruncated = clipped.truncated;
      } else if (body instanceof FormData) {
        const fields: string[] = [];
        body.forEach((value, key) => {
          if (typeof value === "string") fields.push(`${key}=${value}`);
          else fields.push(`${key}=[blob:${value.type || "application/octet-stream"}]`);
        });
        const clipped = clipPayloadText(fields.join("&"));
        requestPayloadPreview = redactPayloadPreview(clipped.preview);
        requestPayloadTruncated = clipped.truncated;
      } else if (body instanceof Blob) {
        requestPayloadPreview = `[blob:${body.type || "application/octet-stream"}]`;
        requestPayloadTruncated = false;
      } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const bytes = body.byteLength;
        requestPayloadPreview = `[binary:${bytes} bytes]`;
        requestPayloadTruncated = false;
      } else if (typeof Document !== "undefined" && body instanceof Document) {
        requestPayloadPreview = "[document]";
        requestPayloadTruncated = false;
      } else {
        requestPayloadPreview = "[payload]";
        requestPayloadTruncated = false;
      }

      const pendingKind = guessStreamKindFromRequest({
        requestHeaders: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
        url,
        requestPayloadPreview,
      });
      // Connect+JSON is binary — XHR cannot capture it; do not flash a pending row.
      if (pendingKind && pendingKind !== "connect-json") {
        requestId = nextId();
        startedAt = sentAt;
        announced = true;
        postStart({
          requestId,
          url: redactCaptureUrl(url),
          method,
          requestHeaders:
            Object.keys(requestHeaders).length > 0 ? { ...requestHeaders } : undefined,
          requestPayloadPreview,
          requestPayloadTruncated,
          transport: "xhr" satisfies StreamTransport,
          streamKind: pendingKind,
          startedAt,
        });
      }

      return result;
    }) as XMLHttpRequest["send"];

    const tryStart = (): void => {
      if (!active) return;
      if (captured || finished) return;
      if (xhr.readyState < OriginalXHR.HEADERS_RECEIVED) return;

      let contentType: string;
      try {
        contentType = xhr.getResponseHeader("content-type") ?? "";
      } catch {
        return;
      }

      const kind = resolveStreamKind({
        responseContentType: contentType,
        requestHeaders,
        url: redactCaptureUrl(url),
        requestPayloadPreview,
      });
      // Connect+JSON is binary length-prefixed — XHR responseText corrupts frames.
      if (!kind || kind === "connect-json") {
        if (announced && requestId) {
          postDiscard(requestId);
          announced = false;
          requestId = null;
        }
        return;
      }

      captured = true;
      if (!requestId) requestId = nextId();
      if (startedAt === undefined) startedAt = Date.now();
      lastLen = 0;

      let responseHeaders: Record<string, string> | undefined;
      let statusText: string | undefined;
      try {
        const raw = xhr.getAllResponseHeaders();
        if (raw) responseHeaders = parseRawResponseHeaders(raw);
      } catch {
        // ignore
      }
      try {
        statusText = xhr.statusText || undefined;
      } catch {
        // ignore
      }

      postStart({
        requestId,
        url,
        method,
        status: xhr.status || undefined,
        statusText,
        contentType: contentType || undefined,
        requestHeaders: Object.keys(requestHeaders).length > 0 ? { ...requestHeaders } : undefined,
        responseHeaders:
          responseHeaders && Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
        requestPayloadPreview,
        requestPayloadTruncated,
        transport: "xhr" satisfies StreamTransport,
        streamKind: kind,
        startedAt,
      });
    };

    const emitDelta = (): void => {
      if (!active) return;
      if (!captured || !requestId || finished) return;
      // responseText is only available for default / text responseType
      if (xhr.responseType && xhr.responseType !== "text") {
        return;
      }
      try {
        const text = xhr.responseText ?? "";
        if (text.length > lastLen) {
          const delta = text.slice(lastLen);
          lastLen = text.length;
          if (delta) {
            postChunk({ requestId, text: delta });
          }
        }
      } catch {
        // Ignore if responseText is inaccessible mid-flight
      }
    };

    const finishOk = (): void => {
      if (!active) return;
      if (!captured || !requestId || finished) return;
      emitDelta();
      finished = true;
      postEnd({ requestId, endedAt: Date.now(), closeReason: "complete" });
    };

    const finishErr = (
      message: string,
      closeReason: Extract<StreamCloseReason, "abort" | "error" | "http_error">,
    ): void => {
      if (!active) return;
      if (!captured || !requestId || finished) return;
      emitDelta();
      finished = true;
      postError({ requestId, message, endedAt: Date.now(), closeReason });
    };

    xhr.addEventListener("readystatechange", () => {
      tryStart();
      if (xhr.readyState === OriginalXHR.LOADING || xhr.readyState === OriginalXHR.DONE) {
        emitDelta();
      }
      if (xhr.readyState === OriginalXHR.DONE && captured) {
        if (xhr.status >= 400) {
          const classified = classifyHttpStatus(xhr.status);
          finishErr(classified.message, classified.closeReason);
        } else {
          finishOk();
        }
      }
    });

    xhr.addEventListener("error", () => {
      if (captured) {
        finishErr("XMLHttpRequest network error", "error");
      }
    });

    xhr.addEventListener("abort", () => {
      if (captured) {
        finishErr("XMLHttpRequest aborted", "abort");
      }
    });

    return xhr;
  }

  const PatchedXHR = new Proxy(OriginalXHR, {
    construct(target, args, newTarget) {
      const xhr = Reflect.construct(target, args, newTarget) as XMLHttpRequest;
      return instrumentXhr(xhr);
    },
  });

  window.XMLHttpRequest = PatchedXHR;
  return () => {
    active = false;
    if (window.XMLHttpRequest === PatchedXHR) {
      window.XMLHttpRequest = OriginalXHR;
    }
  };
}
