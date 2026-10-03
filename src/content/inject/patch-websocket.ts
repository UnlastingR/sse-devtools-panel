import type { PostChunk, PostEnd, PostError, PostStart } from "./types";

type JsonRecord = Record<string, unknown>;

export type ChatgptWebSocketTurnItem =
  | { topicId: string; type: "chunk"; encodedItem: string; streamItemId?: string }
  | { topicId: string; type: "done" }
  | { topicId: string; type: "error"; message: string };

/** Redact resumable topic credentials before they cross into extension storage/export. */
export function redactChatgptWebSocketEncodedItem(text: string): string {
  return text.replace(
    /(^|\r?\n)(data:\s*)(\{[^\r\n]*\})(?=\r?\n|$)/g,
    (whole, lineStart: string, prefix: string, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        if (
          !isRecord(parsed) ||
          parsed.type !== "resume_conversation_token" ||
          typeof parsed.token !== "string"
        ) {
          return whole;
        }
        return `${lineStart}${prefix}${JSON.stringify({ ...parsed, token: "[REDACTED]" })}`;
      } catch {
        return whole;
      }
    },
  );
}

type TopicState = {
  requestId: string;
  startedAt: number;
  seenStreamItemIds: Set<string>;
  ended: boolean;
  socketId: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatgptSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url, location.href);
    return parsed.protocol === "wss:" && parsed.hostname.toLowerCase() === "ws.chatgpt.com";
  } catch {
    return false;
  }
}

function conversationTurnTopic(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("conversation-turn-");
}

function redactedSocketTopicUrl(socketUrl: string, topicId: string): string {
  try {
    const parsed = new URL(socketUrl, location.href);
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/(\/ws\/user\/)[^/]+$/i, "$1[redacted]");
    parsed.hash = topicId;
    return parsed.toString();
  } catch {
    return `wss://ws.chatgpt.com/ws/user/[redacted]#${topicId}`;
  }
}

function collectTopicEntry(entry: JsonRecord, out: ChatgptWebSocketTurnItem[]): void {
  if (entry.type !== "message" || !conversationTurnTopic(entry.topic_id)) return;
  const topicId = entry.topic_id;
  if (!isRecord(entry.payload) || entry.payload.type !== "conversation-turn-stream") return;
  if (!isRecord(entry.payload.payload)) return;

  const payload = entry.payload.payload;
  if (payload.type === "done") {
    out.push({ topicId, type: "done" });
    return;
  }
  if (payload.type === "error") {
    out.push({
      topicId,
      type: "error",
      message: typeof payload.message === "string" ? payload.message : "WebSocket turn error",
    });
    return;
  }
  if (payload.type !== "stream-item" || typeof payload.encoded_item !== "string") return;

  const streamItemId =
    typeof payload.stream_item_id === "string" ? payload.stream_item_id : undefined;
  out.push({
    topicId,
    type: "chunk",
    encodedItem: payload.encoded_item,
    ...(streamItemId ? { streamItemId } : {}),
  });
}

/** Extract ChatGPT turn-stream items from a WS frame, including subscribe catch-ups. */
export function extractChatgptWebSocketTurnItems(value: unknown): ChatgptWebSocketTurnItem[] {
  const out: ChatgptWebSocketTurnItem[] = [];
  const entries = Array.isArray(value) ? value : [value];
  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    collectTopicEntry(raw, out);
    if (raw.type === "reply" && isRecord(raw.reply) && Array.isArray(raw.reply.catchups)) {
      for (const catchup of raw.reply.catchups) {
        if (isRecord(catchup)) collectTopicEntry(catchup, out);
      }
    }
  }
  return out;
}

/**
 * Capture ChatGPT Work's per-turn WebSocket topic stream.
 *
 * ChatGPT transports each turn as JSON WebSocket envelopes whose `encoded_item`
 * field contains the same SSE-shaped frames used by the regular web-chat
 * conversation endpoint. We expose WebSocket as its own transport while passing
 * only `encoded_item` into the existing SSE parser/ChatGPT merger.
 */
export function patchWebSocket(
  nextId: () => string,
  postStart: PostStart,
  postChunk: PostChunk,
  postEnd: PostEnd,
  postError: PostError,
): void {
  const OriginalWebSocket = window.WebSocket;
  const topics = new Map<string, TopicState>();
  let socketSeq = 0;

  const ensureTopic = (topicId: string, socketUrl: string, socketId: number): TopicState => {
    let state = topics.get(topicId);
    if (state && !state.ended) return state;

    state = {
      requestId: nextId(),
      startedAt: Date.now(),
      seenStreamItemIds: new Set(),
      ended: false,
      socketId,
    };
    topics.set(topicId, state);
    postStart({
      requestId: state.requestId,
      url: redactedSocketTopicUrl(socketUrl, topicId),
      method: "WS",
      status: 101,
      statusText: "Switching Protocols",
      contentType: "application/websocket+json; encoded-item=text/event-stream",
      transport: "websocket",
      streamKind: "sse",
      startedAt: state.startedAt,
    });
    return state;
  };

  const finishTopic = (topicId: string, closeReason: "complete" | "abort" = "complete") => {
    const state = topics.get(topicId);
    if (!state || state.ended) return;
    state.ended = true;
    state.seenStreamItemIds.clear();
    postEnd({ requestId: state.requestId, endedAt: Date.now(), closeReason });
  };

  const failTopic = (topicId: string, message: string) => {
    const state = topics.get(topicId);
    if (!state || state.ended) return;
    state.ended = true;
    state.seenStreamItemIds.clear();
    postError({ requestId: state.requestId, message, endedAt: Date.now(), closeReason: "error" });
  };

  const processEnvelope = (value: unknown, socketUrl: string, socketId: number): void => {
    for (const item of extractChatgptWebSocketTurnItems(value)) {
      if (item.type === "done") {
        finishTopic(item.topicId);
        continue;
      }
      if (item.type === "error") {
        failTopic(item.topicId, item.message);
        continue;
      }

      const existing = topics.get(item.topicId);
      if (existing?.ended) continue;
      const state = ensureTopic(item.topicId, socketUrl, socketId);
      if (item.streamItemId) {
        if (state.seenStreamItemIds.has(item.streamItemId)) continue;
        state.seenStreamItemIds.add(item.streamItemId);
      }
      postChunk({
        requestId: state.requestId,
        text: redactChatgptWebSocketEncodedItem(item.encodedItem),
      });
    }
  };

  function PatchedWebSocket(
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const instance =
      protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
    const socketUrl = String(url);
    if (!isChatgptSocketUrl(socketUrl)) return instance;
    const socketId = ++socketSeq;

    instance.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        processEnvelope(JSON.parse(event.data) as unknown, socketUrl, socketId);
      } catch {
        // Non-JSON/control frames are outside the ChatGPT topic protocol.
      }
    });

    instance.addEventListener("close", () => {
      for (const [topicId, state] of topics) {
        if (state.socketId !== socketId) continue;
        if (!state.ended) {
          postError({
            requestId: state.requestId,
            message: "WebSocket closed before turn completion",
            endedAt: Date.now(),
            closeReason: "error",
          });
          state.ended = true;
        }
        if (state.ended) topics.delete(topicId);
      }
    });

    return instance;
  }

  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  Object.defineProperty(PatchedWebSocket, "CONNECTING", { value: OriginalWebSocket.CONNECTING });
  Object.defineProperty(PatchedWebSocket, "OPEN", { value: OriginalWebSocket.OPEN });
  Object.defineProperty(PatchedWebSocket, "CLOSING", { value: OriginalWebSocket.CLOSING });
  Object.defineProperty(PatchedWebSocket, "CLOSED", { value: OriginalWebSocket.CLOSED });

  window.WebSocket = PatchedWebSocket as unknown as typeof WebSocket;
}
