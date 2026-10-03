import { isChatgptConversationUrl } from "./ai-profile";
import type { SseEvent, StreamRecord } from "./types";

type JsonRecord = Record<string, unknown>;

export interface ChatgptTurnIdentity {
  conversationId: string;
  workingTurnId: string;
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

/**
 * Extract the stable logical-turn key used by ChatGPT Web across connector
 * approval/denial continuations. `turn_exchange_id` may change when the UI
 * resumes after an interaction, while `working_turn_id` stays stable.
 */
export function chatgptTurnIdentity(
  events: ReadonlyArray<Pick<SseEvent, "data" | "event">>,
): ChatgptTurnIdentity | null {
  let conversationId = "";
  let workingTurnId = "";

  for (const ev of events) {
    const parsed = parseJson(ev.data);
    if (!parsed) continue;
    if (!conversationId && typeof parsed.conversation_id === "string") {
      conversationId = parsed.conversation_id;
    }

    if (!workingTurnId && parsed.type === "input_message" && isRecord(parsed.input_message)) {
      const metadata = messageMetadata(parsed.input_message);
      if (metadata && typeof metadata.working_turn_id === "string") {
        workingTurnId = metadata.working_turn_id;
      }
    }

    if (!workingTurnId && isRecord(parsed.v) && isRecord(parsed.v.message)) {
      const metadata = messageMetadata(parsed.v.message);
      if (metadata && typeof metadata.working_turn_id === "string") {
        workingTurnId = metadata.working_turn_id;
      }
    }

    if (conversationId && workingTurnId) return { conversationId, workingTurnId };
  }
  return null;
}

export function chatgptTurnKey(record: StreamRecord): string | null {
  if (!isChatgptConversationUrl(record.url)) return null;
  const identity = chatgptTurnIdentity(record.events);
  return identity ? `${identity.conversationId}:${identity.workingTurnId}` : null;
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
  const anyError = related.some((record) => record.streamStatus === "error");

  return {
    ...selected,
    requestId: `chatgpt-turn:${selectedKey}`,
    startedAt: first.startedAt,
    endedAt: anyStreaming ? undefined : last.endedAt,
    streamStatus: anyStreaming ? "streaming" : anyError ? "error" : "done",
    errorMessage: anyError
      ? related.find((record) => record.errorMessage)?.errorMessage
      : undefined,
    closeReason: anyStreaming ? undefined : last.closeReason,
    raw: "",
    events: related.flatMap((record) => record.events),
  };
}
