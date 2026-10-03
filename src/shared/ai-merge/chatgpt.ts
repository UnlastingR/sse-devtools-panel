import type { SseEvent } from "../types";
import type { AiEndMeta, AiToolCall, MergeChannelsResult } from "./types";
import { isRecord, parseEventData } from "./helpers";

type ChatgptMessage = {
  id: string;
  role: string;
  recipient?: string;
  channel?: string | null;
  contentType?: string;
  text: string;
  metadata: Record<string, unknown>;
  status?: string;
  endTurn?: boolean | null;
};

export type ChatgptWebMergeState = {
  messages: Map<string, ChatgptMessage>;
  order: string[];
  currentMessageId?: string;
  lastPath: string;
  lastOp: string;
  endMeta: AiEndMeta;
  chunkCount: number;
};

function messageText(content: unknown): { contentType?: string; text: string } {
  if (!isRecord(content)) return { text: "" };
  const contentType = typeof content.content_type === "string" ? content.content_type : undefined;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const first = parts.length > 0 && typeof parts[0] === "string" ? parts[0] : "";
  if (first) return { contentType, text: first };
  if (typeof content.text === "string") return { contentType, text: content.text };
  return { contentType, text: "" };
}

function ingestMessage(raw: unknown, state: ChatgptWebMergeState): void {
  if (!isRecord(raw) || typeof raw.id !== "string") return;
  const author = isRecord(raw.author) ? raw.author : null;
  const role = author && typeof author.role === "string" ? author.role : "unknown";
  const parsedContent = messageText(raw.content);
  const metadata = isRecord(raw.metadata) ? { ...raw.metadata } : {};
  const existing = state.messages.get(raw.id);
  const msg: ChatgptMessage = {
    id: raw.id,
    role,
    recipient: typeof raw.recipient === "string" ? raw.recipient : existing?.recipient,
    channel:
      typeof raw.channel === "string" || raw.channel === null ? raw.channel : existing?.channel,
    contentType: parsedContent.contentType ?? existing?.contentType,
    text: parsedContent.text || existing?.text || "",
    metadata: { ...(existing?.metadata ?? {}), ...metadata },
    status: typeof raw.status === "string" ? raw.status : existing?.status,
    endTurn:
      typeof raw.end_turn === "boolean" || raw.end_turn === null ? raw.end_turn : existing?.endTurn,
  };
  if (!existing) state.order.push(raw.id);
  state.messages.set(raw.id, msg);
  state.currentMessageId = raw.id;
  state.lastPath = "";
  state.lastOp = "";

  const model = msg.metadata.resolved_model_slug ?? msg.metadata.model_slug;
  if (typeof model === "string") state.endMeta.model = model;
}

function currentMessage(state: ChatgptWebMergeState): ChatgptMessage | undefined {
  return state.currentMessageId ? state.messages.get(state.currentMessageId) : undefined;
}

function joinPointer(base: string, child: string): string {
  if (!base) return child || "";
  if (!child) return base;
  if (child.startsWith("/")) return `${base}${child}`;
  return `${base}/${child}`;
}

function setMetadataPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (!isRecord(next)) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (last) cur[last] = value;
}

function applyMessagePatch(
  path: string,
  op: string,
  value: unknown,
  state: ChatgptWebMergeState,
): void {
  const msg = currentMessage(state);
  if (!msg) return;

  if (op === "patch" && Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const childPath = typeof item.p === "string" ? item.p : "";
      const childOp = typeof item.o === "string" ? item.o : "";
      applyMessagePatch(joinPointer(path, childPath), childOp, item.v, state);
    }
    return;
  }

  if (path === "/message/content/parts/0") {
    if (op === "append" && typeof value === "string") msg.text += value;
    else if ((op === "replace" || op === "add") && typeof value === "string") msg.text = value;
    return;
  }

  if (path === "/message/status" && typeof value === "string") {
    msg.status = value;
    return;
  }
  if (path === "/message/end_turn" && (typeof value === "boolean" || value === null)) {
    msg.endTurn = value;
    if (value === true) state.endMeta.finishReason = "stop";
    return;
  }
  if (path === "/message/metadata" && isRecord(value) && (op === "append" || op === "add")) {
    Object.assign(msg.metadata, value);
    const model = msg.metadata.resolved_model_slug ?? msg.metadata.model_slug;
    if (typeof model === "string") state.endMeta.model = model;
    return;
  }
  const metadataPrefix = "/message/metadata/";
  if (path.startsWith(metadataPrefix) && (op === "add" || op === "replace" || op === "append")) {
    setMetadataPath(msg.metadata, path.slice(metadataPrefix.length), value);
  }
}

function ingestDelta(parsed: Record<string, unknown>, state: ChatgptWebMergeState): void {
  if (isRecord(parsed.v) && isRecord(parsed.v.message)) {
    ingestMessage(parsed.v.message, state);
    state.chunkCount++;
    return;
  }

  if (typeof parsed.p === "string") state.lastPath = parsed.p;
  if (typeof parsed.o === "string") state.lastOp = parsed.o;
  if (!("v" in parsed)) return;

  applyMessagePatch(state.lastPath, state.lastOp, parsed.v, state);
  state.chunkCount++;
}

function visibleAssistantText(state: ChatgptWebMergeState): string {
  const out: string[] = [];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.role !== "assistant" || !msg.text) continue;
    if (msg.metadata.is_visually_hidden_from_conversation === true) continue;
    if (msg.recipient && msg.recipient !== "all") continue;
    if (msg.contentType && msg.contentType !== "text") continue;
    if (msg.channel && msg.channel !== "commentary" && msg.channel !== "final") continue;
    out.push(msg.text);
  }
  return out.join("\n\n");
}

function toolCalls(state: ChatgptWebMergeState): AiToolCall[] {
  const out: AiToolCall[] = [];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.role !== "assistant") continue;
    if (!msg.recipient || msg.recipient === "all") continue;
    if (msg.contentType !== "code") continue;
    const payload = msg.metadata.connector_tool_payload;
    out.push({
      index: out.length,
      id: msg.id,
      name: msg.recipient,
      arguments: typeof payload === "string" ? payload : msg.text || "{}",
    });
  }
  return out;
}

export function createChatgptWebMergeState(): ChatgptWebMergeState {
  return {
    messages: new Map(),
    order: [],
    lastPath: "",
    lastOp: "",
    endMeta: {},
    chunkCount: 0,
  };
}

export function pushChatgptWeb(
  state: ChatgptWebMergeState,
  events: ReadonlyArray<Pick<SseEvent, "data" | "event">>,
): void {
  for (const ev of events) {
    if (ev.event === "delta_encoding") continue;
    if (ev.data.trim() === "[DONE]") {
      state.endMeta.finishReason = state.endMeta.finishReason ?? "stop";
      continue;
    }
    const parsed = parseEventData(ev.data);
    if (!isRecord(parsed)) continue;
    if (ev.event === "delta") {
      ingestDelta(parsed, state);
      continue;
    }
    if (parsed.type === "message_stream_complete") {
      state.endMeta.finishReason = state.endMeta.finishReason ?? "stop";
    }
  }
}

export function snapshotChatgptWeb(state: ChatgptWebMergeState): MergeChannelsResult {
  return {
    channels: {
      content: visibleAssistantText(state),
      reasoning: "",
      tools: toolCalls(state),
    },
    endMeta: state.endMeta,
    chunkCount: state.chunkCount,
  };
}

export function mergeChatgptWeb(
  events: ReadonlyArray<Pick<SseEvent, "data" | "event">>,
): MergeChannelsResult {
  const state = createChatgptWebMergeState();
  pushChatgptWeb(state, events);
  return snapshotChatgptWeb(state);
}
