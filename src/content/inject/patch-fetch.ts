import { classifyHttpStatus, classifyThrownError } from "../../shared/stream-close";
import type { StreamKind } from "../../shared/types";
import {
  guessStreamKindFromRequest,
  payloadLooksLikeStreamTrue,
  requestAcceptsEventStream,
  requestAcceptsNdjson,
  requestLooksLikeConnectJson,
  resolveStreamKind,
  urlLooksLikeStreamQuery,
} from "./detect";
import {
  collectFetchRequestMetaSync,
  normalizeResponseHeaders,
  redactCaptureUrl,
  resolveMethod,
  resolveUrl,
} from "./headers";
import { captureFetchResponseBody, createConnectJsonSink, createFetchTextSink } from "./stream";
import type { PostChunk, PostDiscard, PostEnd, PostError, PostStart } from "./types";

function isChatGptConversationStream(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    const isConversationPath =
      parsed.pathname === "/backend-api/f/conversation" ||
      parsed.pathname === "/backend-api/f/conversation/resume";
    return (
      (parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com")) &&
      isConversationPath
    );
  } catch {
    return false;
  }
}

/**
 * ChatGPT's ordinary JSON APIs are not streaming endpoints. Let them use the
 * exact page-native fetch, including its original Promise and rejection timing.
 * This is especially important for auth, account, model and bootstrap requests.
 */
export function bypassChatGptJsonApi(input: RequestInfo | URL, init?: RequestInit): boolean {
  try {
    const url = new URL(resolveUrl(input), window.location.href);
    if (url.hostname !== "chatgpt.com" && !url.hostname.endsWith(".chatgpt.com")) {
      return false;
    }
    if (!url.pathname.startsWith("/backend-api/")) return false;
    if (
      url.pathname === "/backend-api/conversation" ||
      url.pathname === "/backend-api/f/conversation" ||
      url.pathname === "/backend-api/f/conversation/resume"
    ) {
      return false;
    }
    if (urlLooksLikeStreamQuery(url.href)) return false;

    const headers = new Headers(
      init?.headers ??
        (typeof input !== "string" && !(input instanceof URL) && input instanceof Request
          ? input.headers
          : undefined),
    );
    const requestHeaders = {
      accept: headers.get("accept") ?? "",
      "content-type": headers.get("content-type") ?? "",
    };
    if (
      requestAcceptsEventStream(requestHeaders) ||
      requestAcceptsNdjson(requestHeaders) ||
      requestLooksLikeConnectJson(requestHeaders)
    ) {
      return false;
    }
    if (typeof init?.body === "string" && payloadLooksLikeStreamTrue(init.body)) {
      return false;
    }
    return true;
  } catch {
    // Conservative fallback: capture rather than guessing for unknown URLs.
    return false;
  }
}

export function patchFetch(
  nextId: () => string,
  postStart: PostStart,
  postChunk: PostChunk,
  postEnd: PostEnd,
  postError: PostError,
  postDiscard: PostDiscard,
): () => void {
  const originalFetch = window.fetch;
  let active = true;

  const captureFetch = async (
    target: typeof window.fetch,
    thisArg: unknown,
    argArray: Parameters<typeof window.fetch>,
  ): Promise<Response> => {
    // Dispatch the native request before doing any capture work. This keeps the
    // page-visible timing as close as possible to an untouched window.fetch.
    const responsePromise = Reflect.apply(target, thisArg, argArray) as Promise<Response>;
    const [input, init] = argArray;
    const requestId = nextId();
    const url = resolveUrl(input);
    const method = resolveMethod(input, init);
    const startedAt = Date.now();
    let reqMeta: ReturnType<typeof collectFetchRequestMetaSync> = {};
    try {
      reqMeta = collectFetchRequestMetaSync(input, init);
    } catch {
      // Metadata capture is best effort and must never affect the page request.
    }
    let announced = false;

    const announce = (extra: {
      status?: number;
      statusText?: string;
      contentType?: string;
      streamKind: StreamKind;
      url?: string;
      responseHeaders?: Record<string, string>;
    }): void => {
      if (!active) return;
      try {
        postStart({
          requestId,
          url: redactCaptureUrl(extra.url ?? url),
          method,
          status: extra.status,
          statusText: extra.statusText,
          contentType: extra.contentType,
          requestHeaders: reqMeta.headers,
          responseHeaders: extra.responseHeaders,
          requestPayloadPreview: reqMeta.payloadPreview,
          requestPayloadTruncated: reqMeta.payloadTruncated,
          transport: "fetch",
          streamKind: extra.streamKind,
          startedAt,
        });
        announced = true;
      } catch {
        // A failed recorder must never fail the fetch itself.
      }
    };

    const pendingKind = guessStreamKindFromRequest({
      requestHeaders: reqMeta.headers,
      url,
      requestPayloadPreview: reqMeta.payloadPreview,
    });
    if (pendingKind) announce({ streamKind: pendingKind });

    try {
      const response = await responsePromise;
      // Everything after the native fetch has resolved is best-effort capture.
      // Never reject or replace a valid Response due to extension errors.
      try {
        const contentType = response.headers.get("content-type");
        const streamKind = resolveStreamKind({
          responseContentType: contentType,
          requestHeaders: reqMeta.headers,
          url: response.url || url,
          requestPayloadPreview: reqMeta.payloadPreview,
        });
        if (!streamKind) {
          if (announced && active) postDiscard(requestId);
          return response;
        }

        announce({
          status: response.status,
          statusText: response.statusText || undefined,
          contentType: contentType ?? undefined,
          streamKind,
          url: response.url || url,
          responseHeaders: normalizeResponseHeaders(response.headers),
        });

        // Request hints can say SSE even when the server returns a JSON 403/502.
        // Preserve the actual HTTP failure without touching/reading its body.
        if (response.status >= 400) {
          const classified = classifyHttpStatus(response.status);
          if (active) {
            postError({
              requestId,
              message: classified.message,
              endedAt: Date.now(),
              closeReason: classified.closeReason,
            });
          }
          return response;
        }

        const guardedChunk: PostChunk = (payload) => {
          if (active) postChunk(payload);
        };
        const guardedEnd: PostEnd = (payload) => {
          if (active) postEnd(payload);
        };
        const guardedError: PostError = (payload) => {
          if (active) postError(payload);
        };
        const sink =
          streamKind === "connect-json"
            ? createConnectJsonSink(requestId, guardedChunk, guardedEnd, guardedError)
            : createFetchTextSink(requestId, guardedChunk, guardedEnd, guardedError);
        // Keep ChatGPT's long-lived conversation SSE streams single-consumer.
        // response.clone() tees the body into another consumer, which can change
        // buffering/backpressure behavior for a stream that may stay open for a
        // long time. Observe the page's own reads instead.
        const captureMode = isChatGptConversationStream(response.url || url) ? "observe" : "clone";
        return captureFetchResponseBody(response, sink, captureMode);
      } catch {
        // Fetch succeeded: ignore instrumentation errors rather than making
        // the application see a spurious network failure.
        return response;
      }
    } catch (err) {
      if (announced) {
        const classified = classifyThrownError(err);
        if (active) {
          try {
            postError({
              requestId,
              message: classified.message,
              endedAt: Date.now(),
              closeReason: classified.closeReason,
            });
          } catch {
            // Do not mask the original fetch rejection.
          }
        }
      }
      throw err;
    }
  };

  const patchedFetch = new Proxy(originalFetch, {
    apply(target, thisArg, argArray) {
      if (!active) {
        // Another interceptor may retain this Proxy after our uninstall.
        // Inactive hooks must delegate without an async boundary.
        return Reflect.apply(target, thisArg, argArray);
      }
      if (bypassChatGptJsonApi(argArray[0] as RequestInfo | URL, argArray[1] as RequestInit)) {
        return Reflect.apply(target, thisArg, argArray);
      }
      return captureFetch(target, thisArg, argArray as Parameters<typeof window.fetch>);
    },
  });

  window.fetch = patchedFetch;
  return () => {
    active = false;
    if (window.fetch === patchedFetch) window.fetch = originalFetch;
  };
}
