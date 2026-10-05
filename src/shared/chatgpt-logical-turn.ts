import { detectAiProfile, isChatgptConversationUrl, type AiProfile } from "./ai-profile";
import type { SseEvent, StreamRecord } from "./types";

type JsonRecord = Record<string, unknown>;

export interface ChatgptTurnIdentity {
  conversationId: string;
  workingTurnId: string;
  turnExchangeId?: string;
}

export interface ChatgptTurnGroup {
  key: string;
  profile: Extract<AiProfile, "chatgpt-web-chat" | "chatgpt-web-work">;
  conversationId: string;
  workingTurnId: string;
  records: StreamRecord[];
}

type CachedRecordAnalysis = {
  eventCount: number;
  lastEvent?: SseEvent;
  url: string;
  requestPayloadPreview?: string;
  identity: ChatgptTurnIdentity | null;
  profile: AiProfile;
  fileIds: Set<string>;
  inputMessageIds: Set<string>;
  uploadOriginationMessageId?: string;
};

/**
 * Sidebar rendering can run once per animation frame while a turn is streaming.
 * Cache all expensive record-wide ChatGPT scans so completed mother turns are not
 * JSON-parsed from the beginning again for every packet of every later turn.
 */
const recordAnalysisCache = new WeakMap<StreamRecord, CachedRecordAnalysis>();

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

function isChatgptUploadStreamUrl(url: string): boolean {
  try {
    const parsed = new URL(url, "https://dummy.local");
    return (
      parsed.hostname.toLowerCase() === "chatgpt.com" &&
      parsed.pathname.includes("/backend-api/files/process_upload_stream")
    );
  } catch {
    return url.includes("/backend-api/files/process_upload_stream");
  }
}

function collectFileIds(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 12 || value == null) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(/(?:sediment:\/\/)?(file_[A-Za-z0-9_-]+)/g)) {
      if (match[1]) out.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileIds(item, out, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:file_id|file_ids|attachment_id|attachment_ids)$/i.test(key)) {
      if (typeof item === "string" && item.startsWith("file_")) out.add(item);
      if (Array.isArray(item)) {
        for (const id of item) {
          if (typeof id === "string" && id.startsWith("file_")) out.add(id);
        }
      }
    }
    collectFileIds(item, out, depth + 1);
  }
}

function computeChatgptRecordFileIds(record: StreamRecord): Set<string> {
  const out = new Set<string>();
  if (record.requestPayloadPreview) {
    try {
      collectFileIds(JSON.parse(record.requestPayloadPreview) as unknown, out);
    } catch {
      for (const match of record.requestPayloadPreview.matchAll(/\bfile_[A-Za-z0-9_-]+\b/g)) {
        out.add(match[0]);
      }
    }
  }
  try {
    const parsed = new URL(record.url, "https://dummy.local");
    for (const value of parsed.searchParams.values()) {
      if (value.startsWith("file_")) out.add(value);
    }
  } catch {
    // best effort only
  }
  for (const event of record.events) {
    const parsed = parseJson(event.data);
    if (parsed) collectFileIds(parsed, out);
  }
  return out;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function computeUploadOriginationMessageId(record: StreamRecord): string | undefined {
  if (!isChatgptUploadStreamUrl(record.url) || !record.requestPayloadPreview) return undefined;
  try {
    const parsed = JSON.parse(record.requestPayloadPreview) as unknown;
    if (!isRecord(parsed)) return undefined;
    const libraryInfo = isRecord(parsed.library_file_info) ? parsed.library_file_info : null;
    const id = libraryInfo?.origination_message_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    const match = record.requestPayloadPreview.match(/"origination_message_id"\s*:\s*"([^"]+)"/i);
    return match?.[1] || undefined;
  }
}

function computeChatgptInputMessageIds(record: StreamRecord): Set<string> {
  const out = new Set<string>();
  for (const event of record.events) {
    const parsed = parseJson(event.data);
    if (!parsed) continue;
    if (parsed.type === "input_message" && isRecord(parsed.input_message)) {
      const id = parsed.input_message.id;
      if (typeof id === "string" && id) out.add(id);
    }
    if (isRecord(parsed.v) && isRecord(parsed.v.message)) {
      const message = parsed.v.message;
      const author = isRecord(message.author) ? message.author : null;
      if (author?.role !== "user") continue;
      const id = message.id;
      if (typeof id === "string" && id) out.add(id);
    }
  }
  return out;
}

function analyzeRecord(record: StreamRecord): CachedRecordAnalysis {
  const lastEvent = record.events.at(-1);
  const cached = recordAnalysisCache.get(record);
  if (
    cached &&
    cached.eventCount === record.events.length &&
    cached.lastEvent === lastEvent &&
    cached.url === record.url &&
    cached.requestPayloadPreview === record.requestPayloadPreview
  ) {
    return cached;
  }

  const analysis: CachedRecordAnalysis = {
    eventCount: record.events.length,
    lastEvent,
    url: record.url,
    requestPayloadPreview: record.requestPayloadPreview,
    identity: chatgptTurnIdentity(record.events),
    profile: detectAiProfile(record.events, record.url).profile,
    fileIds: computeChatgptRecordFileIds(record),
    inputMessageIds: computeChatgptInputMessageIds(record),
    uploadOriginationMessageId: computeUploadOriginationMessageId(record),
  };
  recordAnalysisCache.set(record, analysis);
  return analysis;
}

export function chatgptRecordFileIds(record: StreamRecord): Set<string> {
  // Return a copy so callers cannot corrupt the internal cache.
  return new Set(analyzeRecord(record).fileIds);
}

function uploadOwnerConversation(
  upload: StreamRecord,
  records: ReadonlyArray<StreamRecord>,
): StreamRecord | undefined {
  if (!isChatgptUploadStreamUrl(upload.url)) return undefined;
  const conversations = records
    .filter((record) => isChatgptConversationUrl(record.url))
    .sort((a, b) => a.startedAt - b.startedAt || a.requestId.localeCompare(b.requestId));

  const originationMessageId = analyzeRecord(upload).uploadOriginationMessageId;
  if (originationMessageId) {
    const exact = conversations.find((record) =>
      analyzeRecord(record).inputMessageIds.has(originationMessageId),
    );
    if (exact) return exact;
  }

  const uploadFiles = analyzeRecord(upload).fileIds;
  if (uploadFiles.size === 0) return undefined;
  const matching = conversations.filter((record) =>
    intersects(uploadFiles, analyzeRecord(record).fileIds),
  );
  if (matching.length === 0) return undefined;

  // A file can remain referenced by later follow-up turns. The physical upload
  // belongs to the first turn that consumes it, not every later turn that keeps
  // the same attachment in context.
  return matching.find((record) => record.startedAt >= upload.startedAt) ?? matching[0];
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
  return analyzeRecord(record).profile;
}

function sameWorkingTurn(record: StreamRecord, identity: ChatgptTurnIdentity): boolean {
  const other = analyzeRecord(record).identity;
  return Boolean(
    other &&
    other.conversationId === identity.conversationId &&
    other.workingTurnId === identity.workingTurnId,
  );
}

function chatTurnGeneration(identity: ChatgptTurnIdentity): string {
  return identity.turnExchangeId ?? identity.workingTurnId;
}

/**
 * Resolve one user-visible ChatGPT turn. Work continuations may change
 * turn_exchange_id after an approval while preserving working_turn_id, so any
 * Work evidence in the family upgrades every sibling stream into one mother
 * turn. Normal Chat keeps follow-up turns separate by generation.
 */
export function resolveChatgptTurnGroup(
  selected: StreamRecord,
  records: Iterable<StreamRecord>,
): ChatgptTurnGroup | null {
  const all = Array.from(records);
  let anchor = selected;
  if (!isChatgptConversationUrl(anchor.url)) {
    if (!isChatgptUploadStreamUrl(anchor.url)) return null;
    anchor = uploadOwnerConversation(anchor, all) ?? selected;
    if (anchor === selected) return null;
  }
  const identity = analyzeRecord(anchor).identity;
  if (!identity) return null;
  const family = all.filter((record) => sameWorkingTurn(record, identity));
  if (!family.some((record) => record.requestId === anchor.requestId)) family.push(anchor);
  const isWork = family.some((record) => chatgptProfile(record) === "chatgpt-web-work");
  const related = isWork
    ? family
    : family.filter((record) => {
        const other = analyzeRecord(record).identity;
        return Boolean(other && chatTurnGeneration(other) === chatTurnGeneration(identity));
      });
  const relatedIds = new Set(related.map((record) => record.requestId));
  for (const record of all) {
    if (!isChatgptUploadStreamUrl(record.url)) continue;
    const owner = uploadOwnerConversation(record, all);
    if (!owner || !relatedIds.has(owner.requestId)) continue;
    if (!related.some((item) => item.requestId === record.requestId)) related.push(record);
  }
  related.sort((a, b) => a.startedAt - b.startedAt || a.requestId.localeCompare(b.requestId));
  const profile = isWork ? "chatgpt-web-work" : "chatgpt-web-chat";
  const generation = isWork ? identity.workingTurnId : chatTurnGeneration(identity);
  return {
    key: `chatgpt-turn:${identity.conversationId}:${generation}`,
    profile,
    conversationId: identity.conversationId,
    workingTurnId: identity.workingTurnId,
    records: related,
  };
}

export function chatgptMotherTurnKey(
  record: StreamRecord,
  records: Iterable<StreamRecord>,
): string | null {
  return resolveChatgptTurnGroup(record, records)?.key ?? null;
}

export function resolveChatgptTurnGroups(records: Iterable<StreamRecord>): ChatgptTurnGroup[] {
  const all = Array.from(records).sort(
    (a, b) => a.startedAt - b.startedAt || a.requestId.localeCompare(b.requestId),
  );
  const seen = new Set<string>();
  const groups: ChatgptTurnGroup[] = [];
  for (const record of all) {
    const group = resolveChatgptTurnGroup(record, all);
    if (!group || seen.has(group.key)) continue;
    seen.add(group.key);
    groups.push(group);
  }
  return groups;
}

export function chatgptTurnKey(record: StreamRecord): string | null {
  if (!isChatgptConversationUrl(record.url)) return null;
  const analysis = analyzeRecord(record);
  const identity = analysis.identity;
  if (!identity) return null;
  const profile = analysis.profile;
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
