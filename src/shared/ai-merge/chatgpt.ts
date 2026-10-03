import type { SseEvent } from "../types";
import type { AiEndMeta, AiToolCall, MergeChannelsResult } from "./types";
import { isRecord, parseEventData } from "./helpers";

type ChatgptMessage = {
  id: string;
  role: string;
  authorName?: string;
  createdAt?: number;
  recipient?: string;
  channel?: string | null;
  contentType?: string;
  text: string;
  reasoningSummary: string;
  metadata: Record<string, unknown>;
  status?: string;
  endTurn?: boolean | null;
};

const CHATGPT_RICH_BLOCK_RE = /\uE200([A-Za-z0-9_:-]+)\uE202[\s\S]*?\uE201/g;
const CHATGPT_RICH_BLOCK_TAIL_RE = /\uE200[A-Za-z0-9_:-]*\uE202[^\uE201]*$/g;

/**
 * ChatGPT answer text can contain private-use rich-UI markers such as
 * cite/navlist/genui. The DevTools conversation pane is plain text, so hide
 * those transport markers instead of rendering unsupported PUA glyphs.
 */
export function sanitizeChatgptAnswerText(text: string): string {
  if (!text) return text;
  return text
    .replace(CHATGPT_RICH_BLOCK_RE, "")
    .replace(CHATGPT_RICH_BLOCK_TAIL_RE, "")
    .replace(/[\uE200\uE201\uE202]/g, "");
}

export type ChatgptWebMergeState = {
  messages: Map<string, ChatgptMessage>;
  order: string[];
  currentMessageId?: string;
  lastPath: string;
  lastOp: string;
  endMeta: AiEndMeta;
  chunkCount: number;
};

function messageText(content: unknown): {
  contentType?: string;
  text: string;
  reasoningSummary: string;
} {
  if (!isRecord(content)) return { text: "", reasoningSummary: "" };
  const contentType = typeof content.content_type === "string" ? content.content_type : undefined;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const first = parts.length > 0 && typeof parts[0] === "string" ? parts[0] : "";
  if (first) return { contentType, text: first, reasoningSummary: "" };
  if (typeof content.text === "string") {
    return { contentType, text: content.text, reasoningSummary: "" };
  }
  if (contentType === "reasoning_recap" && typeof content.content === "string") {
    return { contentType, text: "", reasoningSummary: content.content };
  }
  if (contentType === "thoughts" && Array.isArray(content.thoughts)) {
    const summaries = content.thoughts
      .map((thought) =>
        isRecord(thought) && typeof thought.summary === "string" ? thought.summary.trim() : "",
      )
      .filter(Boolean);
    return { contentType, text: "", reasoningSummary: summaries.join("\n") };
  }
  return { contentType, text: "", reasoningSummary: "" };
}

function thoughtSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((thought) =>
      isRecord(thought) && typeof thought.summary === "string" ? thought.summary.trim() : "",
    )
    .filter(Boolean);
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
    authorName: author && typeof author.name === "string" ? author.name : existing?.authorName,
    createdAt: typeof raw.create_time === "number" ? raw.create_time : existing?.createdAt,
    recipient: typeof raw.recipient === "string" ? raw.recipient : existing?.recipient,
    channel:
      typeof raw.channel === "string" || raw.channel === null ? raw.channel : existing?.channel,
    contentType: parsedContent.contentType ?? existing?.contentType,
    text: parsedContent.text || existing?.text || "",
    reasoningSummary: parsedContent.reasoningSummary || existing?.reasoningSummary || "",
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

  if (path === "/message/content/thoughts" && op === "append") {
    const summaries = thoughtSummaries(value);
    if (summaries.length > 0) {
      const prefix = msg.reasoningSummary ? "\n" : "";
      msg.reasoningSummary += `${prefix}${summaries.join("\n")}`;
    }
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

function finalAssistantText(state: ChatgptWebMergeState): string {
  const out: string[] = [];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.role !== "assistant" || !msg.text) continue;
    if (msg.metadata.is_visually_hidden_from_conversation === true) continue;
    if (msg.recipient && msg.recipient !== "all") continue;
    if (msg.contentType !== "text") continue;
    const isFinal = msg.channel === "final" || (msg.channel == null && msg.endTurn === true);
    if (!isFinal) continue;
    out.push(sanitizeChatgptAnswerText(msg.text));
  }
  return out.join("\n\n");
}

function parentId(msg: ChatgptMessage): string | undefined {
  return typeof msg.metadata.parent_id === "string" ? msg.metadata.parent_id : undefined;
}

function isLogicalToolCall(msg: ChatgptMessage): boolean {
  return (
    msg.role === "assistant" &&
    Boolean(msg.recipient) &&
    msg.recipient !== "all" &&
    msg.recipient !== "api_tool.call_tool"
  );
}

/**
 * Associate a tool/result message with its nearest logical assistant tool
 * ancestor. This keeps a later nested web.run from being folded into the
 * previous web.run just because it is also a descendant in the message tree.
 */
function belongsToLogicalTool(
  candidate: ChatgptMessage,
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
): boolean {
  if (candidate.id === tool.id) return true;
  if (isLogicalToolCall(candidate)) return false;

  let next = parentId(candidate);
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const parent = state.messages.get(next);
    if (!parent) return false;
    if (isLogicalToolCall(parent)) return parent.id === tool.id;
    next = parentId(parent);
  }
  return false;
}

function logicalToolParent(
  msg: ChatgptMessage,
  state: ChatgptWebMergeState,
): ChatgptMessage | undefined {
  let next = parentId(msg);
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const parent = state.messages.get(next);
    if (!parent) return undefined;
    if (
      parent.role === "assistant" &&
      parent.recipient &&
      parent.recipient !== "all" &&
      parent.recipient !== "api_tool.call_tool"
    ) {
      return parent;
    }
    next = parentId(parent);
  }
  return undefined;
}

function searchQueriesFromMetadata(metadata: Record<string, unknown>): string[] {
  const bag = isRecord(metadata.search_model_queries) ? metadata.search_model_queries : null;
  if (!bag || !Array.isArray(bag.queries)) return [];
  return bag.queries.filter((q): q is string => typeof q === "string");
}

function resultRefId(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const turn = raw.turn_index;
  const type = raw.ref_type;
  const index = raw.ref_index;
  if ((typeof turn === "number" || typeof turn === "string") && typeof type === "string") {
    if (typeof index === "number" || typeof index === "string") {
      return `turn${turn}${type}${index}`;
    }
  }
  return undefined;
}

function searchResultsFromGroups(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const group of value) {
    if (!isRecord(group) || !Array.isArray(group.entries)) continue;
    const domain = typeof group.domain === "string" ? group.domain : "";
    for (const entry of group.entries) {
      if (!isRecord(entry)) continue;
      const title = typeof entry.title === "string" ? entry.title : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      const snippet = typeof entry.snippet === "string" ? entry.snippet : "";
      const site =
        typeof entry.attribution === "string"
          ? entry.attribution
          : typeof entry.site_name === "string"
            ? entry.site_name
            : domain;
      if (!title && !url && !snippet) continue;
      out.push({
        title,
        url,
        snippet,
        site_name: site,
        cite_index: resultRefId(entry.ref_id),
      });
    }
  }
  return out;
}

function searchDetailsForTool(
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
): { queries: string[]; results: Array<Record<string, unknown>> } {
  const queries: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  const seenQueries = new Set<string>();
  const seenResults = new Set<string>();

  const ingest = (msg: ChatgptMessage) => {
    for (const q of searchQueriesFromMetadata(msg.metadata)) {
      if (!seenQueries.has(q)) {
        seenQueries.add(q);
        queries.push(q);
      }
    }
    const inline = isRecord(msg.metadata.inline_cot_expandable_content)
      ? msg.metadata.inline_cot_expandable_content
      : null;
    const groupSets = [msg.metadata.search_result_groups, inline?.search_result_groups];
    for (const groups of groupSets) {
      for (const result of searchResultsFromGroups(groups)) {
        const key = String(result.url || result.title || result.cite_index || "");
        if (key && seenResults.has(key)) continue;
        if (key) seenResults.add(key);
        results.push(result);
      }
    }
  };

  ingest(tool);
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id || !belongsToLogicalTool(msg, tool, state)) continue;
    ingest(msg);
  }
  return { queries, results };
}

function connectorPayloadForTool(tool: ChatgptMessage, state: ChatgptWebMergeState): string {
  const own = tool.metadata.connector_tool_payload;
  if (typeof own === "string" && own) return own;

  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id || !belongsToLogicalTool(msg, tool, state)) continue;
    if (msg.role !== "assistant" || msg.recipient !== "api_tool.call_tool") continue;
    const payload = msg.metadata.connector_tool_payload;
    if (typeof payload === "string" && payload) return payload;
  }
  return tool.text || "{}";
}

function resourceOperation(resourceUri: string): string | undefined {
  const parts = resourceUri.split("/").filter(Boolean);
  const last = parts.at(-1);
  return last ? decodeURIComponent(last) : undefined;
}

function connectorPathIdentity(text: string): {
  provider?: string;
  operation?: string;
} {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || typeof parsed.path !== "string") return {};
    const parts = parsed.path.split("/").filter(Boolean);
    if (parts.length < 2) return {};
    const provider = parts[0]?.trim() || undefined;
    const operation = parts.at(-1)?.trim() || undefined;
    return { provider, operation };
  } catch {
    return {};
  }
}

function toolIdentity(
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
): Pick<AiToolCall, "provider" | "source" | "operation"> {
  const candidates: ChatgptMessage[] = [tool];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id || !belongsToLogicalTool(msg, tool, state)) continue;
    candidates.push(msg);
  }

  for (const msg of candidates) {
    const resource = isRecord(msg.metadata.invoked_resource) ? msg.metadata.invoked_resource : null;
    if (resource) {
      const provider =
        typeof resource.app_name === "string" && resource.app_name.trim()
          ? resource.app_name.trim()
          : undefined;
      const uri = typeof resource.resource_uri === "string" ? resource.resource_uri : "";
      return {
        provider,
        source: resource.contains_mcp_source === true ? "mcp" : "plugin",
        operation: uri ? resourceOperation(uri) : undefined,
      };
    }

    const plugin = isRecord(msg.metadata.invoked_plugin) ? msg.metadata.invoked_plugin : null;
    if (plugin && Object.keys(plugin).length > 0) {
      const provider = [plugin.app_name, plugin.plugin_name, plugin.name, plugin.namespace].find(
        (value): value is string => typeof value === "string" && Boolean(value.trim()),
      );
      const operation = [plugin.operation, plugin.tool_name, plugin.action].find(
        (value): value is string => typeof value === "string" && Boolean(value.trim()),
      );
      return { provider: provider?.trim(), source: "plugin", operation: operation?.trim() };
    }

    if (msg.role === "assistant" && msg.recipient === "api_tool.call_tool") {
      const path = connectorPathIdentity(msg.text);
      if (path.provider || path.operation) {
        return {
          provider: path.provider,
          source: "plugin",
          operation: path.operation,
        };
      }
    }
  }
  return {};
}

function reasoningStartTime(state: ChatgptWebMergeState): number | undefined {
  for (const id of state.order) {
    const msg = state.messages.get(id);
    const value = msg?.metadata.reasoning_start_time;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function reasoningDurationSec(state: ChatgptWebMergeState): number | undefined {
  for (let i = state.order.length - 1; i >= 0; i -= 1) {
    const msg = state.messages.get(state.order[i]!);
    const value = msg?.metadata.finished_duration_sec;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function reasoningTimePrefix(msg: ChatgptMessage, start?: number): string {
  if (start == null || msg.createdAt == null || !Number.isFinite(msg.createdAt)) return "";
  const elapsed = Math.max(0, msg.createdAt - start);
  return `+${elapsed.toFixed(1)}s  `;
}

function reasoningTitle(msg: ChatgptMessage): string {
  return typeof msg.metadata.reasoning_title === "string"
    ? msg.metadata.reasoning_title.trim()
    : "";
}

function visibleReasoningText(state: ChatgptWebMergeState): string {
  const out: string[] = [];
  const seenTitles = new Set<string>();
  const seenSummaries = new Set<string>();
  const start = reasoningStartTime(state);

  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg) continue;
    if (msg.metadata.is_visually_hidden_from_conversation === true) continue;

    const title = reasoningTitle(msg);
    if (title && !seenTitles.has(title)) {
      seenTitles.add(title);
      out.push(`${reasoningTimePrefix(msg, start)}阶段 · ${title}`);
    }

    if (isLogicalToolCall(msg)) {
      if (msg.recipient === "web.run") {
        const search = searchDetailsForTool(msg, state);
        const bits: string[] = [];
        if (search.queries.length > 0) bits.push(`${search.queries.length} 个查询`);
        if (search.results.length > 0) bits.push(`${search.results.length} 个结果`);
        out.push(
          `${reasoningTimePrefix(msg, start)}工具 · web.run${bits.length ? ` · ${bits.join(" / ")}` : ""}`,
        );
      } else {
        const identity = toolIdentity(msg, state);
        const provider = identity.provider
          ? `${identity.provider}${identity.source ? ` [${identity.source.toUpperCase()}]` : ""}`
          : msg.recipient;
        const operation = identity.operation ? ` · ${identity.operation}` : "";
        out.push(`${reasoningTimePrefix(msg, start)}工具 · ${provider}${operation}`);
      }
      continue;
    }

    if (msg.role !== "assistant") continue;
    if (msg.recipient && msg.recipient !== "all") continue;

    // User-visible intermediate commentary belongs in the reasoning pane,
    // not in the final answer. Never expose hidden thought content; for
    // `thoughts` only the server-provided summary is retained.
    if (
      msg.contentType === "text" &&
      (msg.channel === "commentary" || msg.metadata.is_thinking_preamble_message === true) &&
      msg.text
    ) {
      out.push(`${reasoningTimePrefix(msg, start)}说明 · ${msg.text}`);
      continue;
    }
    if (
      (msg.contentType === "reasoning_recap" || msg.contentType === "thoughts") &&
      msg.reasoningSummary
    ) {
      const summary = msg.reasoningSummary.trim();
      const isDurationOnly = /^思考了\s*\d+(?:\.\d+)?s$/i.test(summary);
      if (!isDurationOnly && !seenSummaries.has(summary)) {
        seenSummaries.add(summary);
        out.push(`${reasoningTimePrefix(msg, start)}摘要 · ${summary}`);
      }
    }
  }

  const duration = reasoningDurationSec(state);
  if (duration != null) out.push(`总思考时间：${duration}s`);
  return out.join("\n\n");
}

function toolCalls(state: ChatgptWebMergeState): AiToolCall[] {
  const out: AiToolCall[] = [];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.role !== "assistant") continue;
    if (!msg.recipient || msg.recipient === "all") continue;
    if (msg.recipient === "api_tool.call_tool" && logicalToolParent(msg, state)) continue;

    let args = connectorPayloadForTool(msg, state);
    const identity = toolIdentity(msg, state);
    const isEmptyHiddenWrapper =
      msg.metadata.is_visually_hidden_from_conversation === true &&
      msg.recipient === "functions.exec" &&
      !identity.provider &&
      !identity.operation &&
      (!args || args === "{}");
    if (isEmptyHiddenWrapper) continue;
    if (msg.recipient === "web.run") {
      const search = searchDetailsForTool(msg, state);
      if (search.queries.length > 0 || search.results.length > 0) {
        args = JSON.stringify({ type: "SEARCH", queries: search.queries, results: search.results });
      }
    }
    out.push({
      index: out.length,
      id: msg.id,
      name: msg.recipient,
      ...identity,
      arguments: args || "{}",
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
      content: finalAssistantText(state),
      reasoning: visibleReasoningText(state),
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
