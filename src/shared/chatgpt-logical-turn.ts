import { detectAiProfile, isChatgptConversationUrl, type AiProfile } from "./ai-profile";
import type { SseEvent, StreamRecord } from "./types";

type JsonRecord = Record<string, unknown>;

export interface ChatgptTurnIdentity {
  conversationId: string;
  workingTurnId: string;
  turnExchangeId?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(data: string): JsonRecord | null {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function messageMetadata(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  return isRecord(value.metadata) ? value.metadata : null;
}

/** Extract the identifiers ChatGPT exposes for one browser-visible turn generation. */
export function chatgptTurnIdentity(
  events: ReadonlyArray<Pick<SseEvent, "data" | "event">>,
): ChatgptTurnIdentity | null {
  let conversationId = "";
  let workingTurnId = "";
  let turnExchangeId = "";

  for (const ev of events) {
    const parsed = parseJson(ev.data);
    if (!parsed) continue;
    if (!conversationId && typeof parsed.conversation_id === "string") {
      conversationId = parsed.conversation_id;
    }

    if (
      (!workingTurnId || !turnExchangeId) &&
      parsed.type === "input_message" &&
      isRecord(parsed.input_message)
    ) {
      const metadata = messageMetadata(parsed.input_message);
      if (metadata && typeof metadata.working_turn_id === "string") {
        workingTurnId = metadata.working_turn_id;
      }
      if (!turnExchangeId && metadata && typeof metadata.turn_exchange_id === "string") {
        turnExchangeId = metadata.turn_exchange_id;
      }
    }

    if ((!workingTurnId || !turnExchangeId) && isRecord(parsed.v) && isRecord(parsed.v.message)) {
      const metadata = messageMetadata(parsed.v.message);
      if (metadata && typeof metadata.working_turn_id === "string") {
        workingTurnId = metadata.working_turn_id;
      }
      if (!turnExchangeId && metadata && typeof metadata.turn_exchange_id === "string") {
        turnExchangeId = metadata.turn_exchange_id;
      }
    }

    if (conversationId && workingTurnId && turnExchangeId) {
      return { conversationId, workingTurnId, turnExchangeId };
    }
  }
  return conversationId && workingTurnId
    ? { conversationId, workingTurnId, ...(turnExchangeId ? { turnExchangeId } : {}) }
    : null;
}

function chatgptProfile(record: StreamRecord): AiProfile {
  return detectAiProfile(record.events, record.url).profile;
}

export function chatgptTurnKey(record: StreamRecord): string | null {
  if (!isChatgptConversationUrl(record.url)) return null;
  const identity = chatgptTurnIdentity(record.events);
  if (!identity) return null;
  const profile = chatgptProfile(record);
  if (profile === "chatgpt-web-work") {
    // Work permission/connector continuations deliberately start a new
    // turn_exchange_id while preserving working_turn_id. Treat that as a new
    // stream generation so a completed WS topic cannot keep absorbing a later
    // fetch/SSE continuation and replay stale mutable state into it.
    const generation = identity.turnExchangeId ?? identity.workingTurnId;
    return `work:${identity.conversationId}:${generation}`;
  }
  if (profile === "chatgpt-web-chat") {
    return `chat:${identity.conversationId}:${identity.workingTurnId}`;
  }
  return null;
}

/**
 * Build a Conversation-only logical record spanning multiple HTTP streams.
 * Raw / Events / Request views remain attached to each physical request.
 */
export function combineChatgptTurnRecords(
  selected: StreamRecord,
  records: Iterable<StreamRecord>,
): StreamRecord {
  const selectedKey = chatgptTurnKey(selected);
  if (!selectedKey) return selected;

  const related = Array.from(records)
    .filter(
      (record) => record.requestId === selected.requestId || chatgptTurnKey(record) === selectedKey,
    )
    .sort((a, b) => a.startedAt - b.startedAt || a.requestId.localeCompare(b.requestId));
  if (related.length <= 1) return selected;

  const last = related.at(-1)!;
  const first = related[0]!;
  const anyStreaming = related.some((record) => record.streamStatus === "streaming");
  // A physical /conversation request may fail and then be continued by
  // /conversation/resume. The logical turn should reflect the latest physical
  // stream's terminal state, while Raw / Events / Request keep the original
  // transport error on the interrupted request.
  const logicalStatus = anyStreaming ? "streaming" : last.streamStatus;

  return {
    ...selected,
    requestId: `chatgpt-turn:${selectedKey}`,
    startedAt: first.startedAt,
    endedAt: anyStreaming ? undefined : last.endedAt,
    streamStatus: logicalStatus,
    errorMessage: logicalStatus === "error" ? last.errorMessage : undefined,
    closeReason: anyStreaming ? undefined : last.closeReason,
    raw: "",
    events: related.flatMap((record) => record.events),
  };
}
