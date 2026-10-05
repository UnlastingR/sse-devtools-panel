import { classifyThrownError } from "../../shared/stream-close";
import type { StreamKind } from "../../shared/types";
import { guessStreamKindFromRequest, resolveStreamKind } from "./detect";
import {
  collectFetchRequestMetaSync,
  normalizeResponseHeaders,
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
      postStart({
        requestId,
        url: extra.url ?? url,
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
    };

    const pendingKind = guessStreamKindFromRequest({
      requestHeaders: reqMeta.headers,
      url,
      requestPayloadPreview: reqMeta.payloadPreview,
    });
    if (pendingKind) {
      announce({ streamKind: pendingKind });
    }

    try {
      const response = await responsePromise;

      const contentType = response.headers.get("content-type");
      const streamKind = resolveStreamKind({
        responseContentType: contentType,
        requestHeaders: reqMeta.headers,
        url: response.url || url,
        requestPayloadPreview: reqMeta.payloadPreview,
      });
      if (!streamKind) {
        if (announced) {
          if (active) postDiscard(requestId);
        }
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
    } catch (err) {
      if (announced) {
        const classified = classifyThrownError(err);
        if (active) {
          postError({
            requestId,
            message: classified.message,
            endedAt: Date.now(),
            closeReason: classified.closeReason,
          });
        }
      }
      throw err;
    }
  };

  const patchedFetch = new Proxy(originalFetch, {
    apply(target, thisArg, argArray) {
      return captureFetch(target, thisArg, argArray as Parameters<typeof window.fetch>);
    },
  });

  window.fetch = patchedFetch;
  return () => {
    active = false;
    if (window.fetch === patchedFetch) window.fetch = originalFetch;
  };
}
