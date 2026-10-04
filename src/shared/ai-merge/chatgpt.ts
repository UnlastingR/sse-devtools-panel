import type { SseEvent } from "../types";
import type {
  AiEndMeta,
  AiMergeObservation,
  AiReasoningStage,
  AiToolCall,
  MergeChannelsResult,
} from "./types";
import { isRecord, parseEventData } from "./helpers";

type ChatgptMessage = {
  id: string;
  role: string;
  authorName?: string;
  createdAt?: number;
  updatedAt?: number;
  /** First browser-observed arrival time, in Unix seconds. */
  observedAt?: number;
  /** Latest browser-observed patch time, in Unix seconds. */
  observedUpdatedAt?: number;
  sourceAnalysisMessageId?: string;
  recipient?: string;
  channel?: string | null;
  contentType?: string;
  text: string;
  reasoningSummary: string;
  metadata: Record<string, unknown>;
  status?: string;
  endTurn?: boolean | null;
};

type ReasoningTransition = {
  messageId: string;
  text: string;
  observedAt?: number;
};

type DilToolEvent = {
  messageId: string;
  id: string;
  label?: string;
  connectorId?: string;
  toolName?: string;
  observedAt?: number;
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
  reasoningTransitions: ReasoningTransition[];
  dilToolEvents: DilToolEvent[];
};

function recordDilToolItems(
  state: ChatgptWebMergeState,
  messageId: string,
  value: unknown,
  receivedAtMs?: number,
): void {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || state.dilToolEvents.some((event) => event.id === id)) continue;
    state.dilToolEvents.push({
      messageId,
      id,
      label: typeof item.label === "string" ? item.label : undefined,
      connectorId: typeof item.connectorId === "string" ? item.connectorId : undefined,
      toolName: typeof item.toolName === "string" ? item.toolName : undefined,
      observedAt: observedSeconds(receivedAtMs),
    });
  }
}

function dilToolIdentity(
  event: DilToolEvent,
): Pick<AiToolCall, "provider" | "kind" | "source" | "operation"> {
  const raw = event.toolName ?? "";
  const [namespace, ...operationParts] = raw.split(".");
  const providerMap: Record<string, string> = {
    agentdock: "AgentDock",
    devspace: "Devspace",
    gmail: "Gmail",
    files: "files",
  };
  const provider = providerMap[namespace.toLowerCase()] ?? (namespace || "tool");
  return {
    provider,
    kind: "app",
    source: event.connectorId?.startsWith("asdk_app_") ? "mcp" : undefined,
    operation: operationParts.join(".") || undefined,
  };
}

function dilToolLabel(event: DilToolEvent): string {
  const identity = dilToolIdentity(event);
  const source = identity.source ? ` · ${identity.source.toUpperCase()}` : "";
  const operation = identity.operation ? ` · ${identity.operation}` : "";
  return `${identity.provider ?? "tool"} · APP${source}${operation}`;
}

function cleanReasoningStatus(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u2066-\u2069]/g, "").trim();
  if (!text) return "";
  if (/^(?:thinking|worked)$/i.test(text)) return "";
  if (/^(?:using|used)\s+.+?\s+integration$/i.test(text)) return "";
  return text;
}

function recordReasoningTransition(
  state: ChatgptWebMergeState,
  messageId: string,
  value: unknown,
  receivedAtMs?: number,
): void {
  const text = cleanReasoningStatus(value);
  if (!text) return;
  const observedAt = observedSeconds(receivedAtMs);
  const last = state.reasoningTransitions.at(-1);
  if (last?.messageId === messageId && last.text === text) return;
  state.reasoningTransitions.push({ messageId, text, observedAt });
}

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

function observedSeconds(receivedAtMs?: number): number | undefined {
  return typeof receivedAtMs === "number" && Number.isFinite(receivedAtMs)
    ? receivedAtMs / 1000
    : undefined;
}

function applyChatgptMetadataToEndMeta(
  metadata: Record<string, unknown> | null,
  state: ChatgptWebMergeState,
): void {
  if (!metadata) return;
  const model = metadata.resolved_model_slug ?? metadata.model_slug ?? metadata.backend_model;
  if (typeof model === "string") state.endMeta.model = model;
  if (typeof metadata.thinking_effort === "string" && metadata.thinking_effort.trim()) {
    state.endMeta.thinkingEffort = metadata.thinking_effort.trim();
  }
}

function ingestMessage(raw: unknown, state: ChatgptWebMergeState, receivedAtMs?: number): void {
  if (!isRecord(raw) || typeof raw.id !== "string") return;
  const author = isRecord(raw.author) ? raw.author : null;
  const role = author && typeof author.role === "string" ? author.role : "unknown";
  const parsedContent = messageText(raw.content);
  const rawContent = isRecord(raw.content) ? raw.content : null;
  const metadata = isRecord(raw.metadata) ? { ...raw.metadata } : {};
  const existing = state.messages.get(raw.id);
  const observed = observedSeconds(receivedAtMs);
  const msg: ChatgptMessage = {
    id: raw.id,
    role,
    authorName: author && typeof author.name === "string" ? author.name : existing?.authorName,
    createdAt: typeof raw.create_time === "number" ? raw.create_time : existing?.createdAt,
    updatedAt: typeof raw.update_time === "number" ? raw.update_time : existing?.updatedAt,
    observedAt: existing?.observedAt ?? observed,
    observedUpdatedAt: observed ?? existing?.observedUpdatedAt,
    sourceAnalysisMessageId:
      rawContent && typeof rawContent.source_analysis_msg_id === "string"
        ? rawContent.source_analysis_msg_id
        : existing?.sourceAnalysisMessageId,
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

  applyChatgptMetadataToEndMeta(msg.metadata, state);
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

function metadataPathParts(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isArrayIndex(part: string | undefined): boolean {
  return Boolean(part && /^\d+$/.test(part));
}

function applyMetadataPath(
  target: Record<string, unknown>,
  path: string,
  op: string,
  value: unknown,
): void {
  const parts = metadataPathParts(path);
  if (parts.length === 0) return;

  let cur: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const nextKey = parts[i + 1];
    const existing: unknown = Array.isArray(cur) ? cur[Number(key)] : cur[key];
    if (isRecord(existing) || Array.isArray(existing)) {
      cur = existing;
      continue;
    }
    const created: Record<string, unknown> | unknown[] = isArrayIndex(nextKey) ? [] : {};
    if (Array.isArray(cur)) cur[Number(key)] = created;
    else cur[key] = created;
    cur = created;
  }

  const last = parts.at(-1);
  if (!last) return;
  const getCurrent = (): unknown => (Array.isArray(cur) ? cur[Number(last)] : cur[last]);
  const setCurrent = (next: unknown) => {
    if (Array.isArray(cur)) cur[Number(last)] = next;
    else cur[last] = next;
  };

  if (op === "remove") {
    if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete cur[last];
    return;
  }

  if (op === "append") {
    const existing = getCurrent();
    if (typeof existing === "string" && typeof value === "string") {
      setCurrent(existing + value);
      return;
    }
    if (Array.isArray(existing)) {
      if (Array.isArray(value)) existing.push(...value);
      else existing.push(value);
      return;
    }
    if (isRecord(existing) && isRecord(value)) {
      Object.assign(existing, value);
      return;
    }
    if (existing === undefined) {
      setCurrent(value);
      return;
    }
  }

  setCurrent(value);
}

function applyMessagePatch(
  path: string,
  op: string,
  value: unknown,
  state: ChatgptWebMergeState,
  receivedAtMs?: number,
): void {
  const msg = currentMessage(state);
  if (!msg) return;
  const observed = observedSeconds(receivedAtMs);
  if (observed != null) {
    msg.observedAt ??= observed;
    msg.observedUpdatedAt = observed;
  }

  if (op === "patch" && Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const childPath = typeof item.p === "string" ? item.p : "";
      const childOp = typeof item.o === "string" ? item.o : "";
      applyMessagePatch(joinPointer(path, childPath), childOp, item.v, state, receivedAtMs);
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

  if (/^\/message\/content\/thoughts\/\d+\/summary$/.test(path) && typeof value === "string") {
    if (op === "append") msg.reasoningSummary += value;
    else if (op === "replace" || op === "add") msg.reasoningSummary = value;
    if (!cleanReasoningStatus(msg.metadata.reasoning_title)) {
      recordReasoningTransition(state, msg.id, msg.reasoningSummary, receivedAtMs);
    }
    return;
  }

  if (path === "/message/status" && typeof value === "string") {
    msg.status = value;
    return;
  }
  if (path === "/message/update_time" && typeof value === "number" && Number.isFinite(value)) {
    msg.updatedAt = value;
    return;
  }
  if (path === "/message/end_turn" && (typeof value === "boolean" || value === null)) {
    msg.endTurn = value;
    if (value === true) state.endMeta.finishReason = "stop";
    return;
  }
  if (path === "/message/metadata" && isRecord(value) && (op === "append" || op === "add")) {
    Object.assign(msg.metadata, value);
    applyChatgptMetadataToEndMeta(msg.metadata, state);
    return;
  }
  const metadataPrefix = "/message/metadata/";
  if (
    path.startsWith(metadataPrefix) &&
    (op === "add" || op === "replace" || op === "append" || op === "remove")
  ) {
    if (path === "/message/metadata/dil_v2_reasoning/appData/items" && op === "append") {
      recordDilToolItems(state, msg.id, value, receivedAtMs);
    }
    applyMetadataPath(msg.metadata, path.slice(metadataPrefix.length), op, value);
    if (
      path === "/message/metadata/dil_v2_reasoning/appData/current_status" ||
      path === "/message/metadata/dil_v2_reasoning/appData/title"
    ) {
      recordReasoningTransition(state, msg.id, value, receivedAtMs);
    }
    if (path === "/message/metadata/thinking_effort" && typeof value === "string") {
      state.endMeta.thinkingEffort = value;
    }
  }
}

function ingestDelta(
  parsed: Record<string, unknown>,
  state: ChatgptWebMergeState,
  receivedAtMs?: number,
): void {
  if (isRecord(parsed.v) && isRecord(parsed.v.message)) {
    ingestMessage(parsed.v.message, state, receivedAtMs);
    state.chunkCount++;
    return;
  }

  if (typeof parsed.p === "string") state.lastPath = parsed.p;
  if (typeof parsed.o === "string") state.lastOp = parsed.o;
  if (!("v" in parsed)) return;

  applyMessagePatch(state.lastPath, state.lastOp, parsed.v, state, receivedAtMs);
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

function belongsToApiToolCall(
  candidate: ChatgptMessage,
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
): boolean {
  if (candidate.id === tool.id) return true;
  let next = parentId(candidate);
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const parent = state.messages.get(next);
    if (!parent) return false;
    if (parent.role === "assistant" && parent.recipient === "api_tool.call_tool") {
      return parent.id === tool.id;
    }
    if (parent.role === "assistant" && parent.recipient && parent.recipient !== "all") {
      return false;
    }
    next = parentId(parent);
  }
  return false;
}

function belongsToToolCall(
  candidate: ChatgptMessage,
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
): boolean {
  return tool.recipient === "api_tool.call_tool"
    ? belongsToApiToolCall(candidate, tool, state)
    : belongsToLogicalTool(candidate, tool, state);
}

function isRenderableToolCall(msg: ChatgptMessage, state: ChatgptWebMergeState): boolean {
  if (isLogicalToolCall(msg)) return true;
  return (
    msg.role === "assistant" &&
    msg.recipient === "api_tool.call_tool" &&
    logicalToolParent(msg, state) == null
  );
}

function searchQueriesFromMetadata(metadata: Record<string, unknown>): string[] {
  const bag = isRecord(metadata.search_model_queries) ? metadata.search_model_queries : null;
  if (!bag || !Array.isArray(bag.queries)) return [];
  return bag.queries.filter((q): q is string => typeof q === "string");
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
      const refId = isRecord(entry.ref_id) ? entry.ref_id : null;
      const refType = refId && typeof refId.ref_type === "string" ? refId.ref_type : undefined;
      out.push({
        title,
        url,
        snippet,
        site_name: site,
        ...(refType ? { ref_type: refType } : {}),
      });
    }
  }
  return out;
}

type WebRunOperation = "SEARCH" | "VIEW";

function webRunOperation(details: {
  queries: string[];
  results: Array<Record<string, unknown>>;
}): WebRunOperation {
  if (details.queries.length > 0) return "SEARCH";
  if (details.results.some((result) => result.ref_type === "view" || result.ref_type === "open")) {
    return "VIEW";
  }
  // A result-only web.run step is page retrieval/browsing rather than a new query.
  return details.results.length > 0 ? "VIEW" : "SEARCH";
}

function directWebRunOperation(msg: ChatgptMessage): WebRunOperation {
  return webRunOperation({
    queries: searchQueriesFromMetadata(msg.metadata),
    results: searchResultsFromGroups(msg.metadata.search_result_groups),
  });
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

function builtinProvider(provider: string | undefined): boolean {
  return (
    provider === "files" ||
    provider === "python" ||
    provider === "container" ||
    provider === "safety_settings" ||
    provider === "genui" ||
    provider === "automations" ||
    provider === "summary_reader" ||
    provider === "personal_context" ||
    provider === "image_gen" ||
    provider === "guardian_tool" ||
    provider === "artifact_handoff" ||
    provider === "python_user_visible" ||
    provider === "bio"
  );
}

function directBuiltinIdentity(
  tool: ChatgptMessage,
): Pick<AiToolCall, "provider" | "kind" | "operation"> | null {
  const recipient = tool.recipient?.trim();
  if (!recipient) return null;
  const dot = recipient.indexOf(".");
  if (dot <= 0) return null;
  const provider = recipient.slice(0, dot);
  if (!builtinProvider(provider) || provider === "files" || provider === "python") return null;
  return {
    provider,
    kind: "builtin",
    operation: recipient.slice(dot + 1) || undefined,
  };
}

function webToolCallAncestor(
  msg: ChatgptMessage,
  state: ChatgptWebMergeState,
): ChatgptMessage | undefined {
  let next = parentId(msg);
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const parent = state.messages.get(next);
    if (!parent) return undefined;
    if (parent.role === "assistant" && parent.recipient && parent.recipient !== "all") {
      return parent.recipient === "web.run" ? parent : undefined;
    }
    next = parentId(parent);
  }
  return undefined;
}

function isStandaloneWebToolResult(msg: ChatgptMessage, state: ChatgptWebMergeState): boolean {
  if (msg.role !== "tool" || msg.authorName !== "web.run" || webToolCallAncestor(msg, state)) {
    return false;
  }
  return (
    searchQueriesFromMetadata(msg.metadata).length > 0 ||
    searchResultsFromGroups(msg.metadata.search_result_groups).length > 0
  );
}

function sameChatgptTurn(a: ChatgptMessage, b: ChatgptMessage): boolean {
  const aWorking = a.metadata.working_turn_id;
  const bWorking = b.metadata.working_turn_id;
  if (typeof aWorking === "string" && typeof bWorking === "string") return aWorking === bWorking;
  const aRequest = a.metadata.request_id;
  const bRequest = b.metadata.request_id;
  return typeof aRequest === "string" && typeof bRequest === "string" && aRequest === bRequest;
}

function standaloneWebSearchDetails(
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
    for (const result of searchResultsFromGroups(msg.metadata.search_result_groups)) {
      const key = String(result.url || result.title || "");
      if (key && seenResults.has(key)) continue;
      if (key) seenResults.add(key);
      results.push(result);
    }
  };
  ingest(tool);
  // Direct result groups on the tool message are authoritative. Only look
  // forward for a fallback result payload when the tool itself carries none;
  // final assistant messages may contain the union of all prior search refs,
  // which must not be attributed to the last VIEW call.
  if (results.length === 0) {
    const startIndex = state.order.indexOf(tool.id);
    for (let i = startIndex + 1; i < state.order.length; i += 1) {
      const msg = state.messages.get(state.order[i]!);
      if (!msg || !sameChatgptTurn(msg, tool)) continue;
      if (isStandaloneWebToolResult(msg, state) || msg.recipient === "web.run") break;
      const before = results.length;
      ingest(msg);
      if (results.length > before) break;
    }
  }
  return { queries, results };
}

function recallToolIdentity(
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
): Pick<AiToolCall, "provider" | "kind" | "operation"> | null {
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id || !belongsToLogicalTool(msg, tool, state)) continue;
    if (msg.metadata.tool_summary_type === "personal_context") {
      return { provider: "RECALL", kind: "builtin", operation: "SEARCH" };
    }
  }

  const metadataHints = [
    tool.metadata.tool_name,
    tool.metadata.function_name,
    tool.metadata.recipient_name,
    tool.metadata.tool_namespace,
  ];
  if (
    metadataHints.some(
      (value) =>
        typeof value === "string" &&
        /(?:personal[_ -]?context|recall|memory[_ -]?search)/i.test(value),
    )
  ) {
    return { provider: "RECALL", kind: "builtin", operation: "SEARCH" };
  }

  // ChatGPT currently exposes its personal-context lookup as an opaque
  // short-lived recipient (for example `q7dr546`) rather than a stable tool
  // name. Its public payload is a single natural-language `query`. Keep the
  // opaque recipient as the raw tool name for debugging, but give the UI a
  // stable product-level identity.
  const recipient = tool.recipient?.trim() ?? "";
  if (!/^q[a-z0-9]{6}$/i.test(recipient) || !tool.text) return null;
  try {
    const payload = JSON.parse(tool.text) as unknown;
    if (!isRecord(payload) || typeof payload.query !== "string" || !payload.query.trim()) {
      return null;
    }
    const keys = Object.keys(payload);
    if (keys.length !== 1 || keys[0] !== "query") return null;
    return { provider: "RECALL", kind: "builtin", operation: "SEARCH" };
  } catch {
    return null;
  }
}

function knownMcpProvider(state: ChatgptWebMergeState, provider: string | undefined): boolean {
  if (!provider) return false;
  for (const id of state.order) {
    const msg = state.messages.get(id);
    const resource =
      msg && isRecord(msg.metadata.invoked_resource) ? msg.metadata.invoked_resource : null;
    if (!resource) continue;
    if (resource.app_name === provider && resource.contains_mcp_source === true) return true;
  }
  return false;
}

function toolUiDetails(
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
): Pick<AiToolCall, "presentation" | "uiResource"> {
  const candidates: ChatgptMessage[] = [tool];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id) continue;
    const related = belongsToToolCall(msg, tool, state);
    if (!related) continue;
    candidates.push(msg);
  }

  for (const msg of candidates) {
    const sdk = isRecord(msg.metadata.chatgpt_sdk) ? msg.metadata.chatgpt_sdk : null;
    const pointer =
      sdk && typeof sdk.html_asset_pointer === "string"
        ? sdk.html_asset_pointer
        : typeof msg.metadata.html_asset_pointer === "string"
          ? msg.metadata.html_asset_pointer
          : "";
    if (pointer) return { presentation: "app_ui", uiResource: pointer };
  }
  return {};
}

type ClientWidget = {
  id: string;
  name: string;
  category?: string;
  widgetType?: string;
  arguments: string;
};

function clientWidgetName(ref: Record<string, unknown>, data: Record<string, unknown>): string {
  const matched = typeof ref.matched_text === "string" ? ref.matched_text : "";
  const fromMarker = matched.match(/\uE200genui\uE202\{"?([A-Za-z0-9_:-]+)"?\s*:/)?.[1];
  if (fromMarker) return fromMarker;

  const widgetType = typeof data.widget_type === "string" ? data.widget_type : "";
  const category = typeof ref.category === "string" ? ref.category : "";
  if (widgetType === "charts_widget_v2" || category === "visualization") return "chart";
  if (widgetType === "app_block" || category === "app_block") return "app_block";
  if (category === "map") return "map_widget";
  return category ? `${category}_widget` : "widget";
}

function clientWidgetsFromMessage(msg: ChatgptMessage): ClientWidget[] {
  const refs = msg.metadata.content_references;
  if (!Array.isArray(refs)) return [];
  const out: ClientWidget[] = [];
  refs.forEach((value, index) => {
    if (!isRecord(value) || value.type !== "client_defined_widget") return;
    const data = isRecord(value.data) ? value.data : {};
    const category = typeof value.category === "string" ? value.category : undefined;
    const widgetType = typeof data.widget_type === "string" ? data.widget_type : undefined;
    const name = clientWidgetName(value, data);
    let args = "{}";
    try {
      args = JSON.stringify({ category, widget_type: widgetType, data });
    } catch {
      // Keep a valid empty payload if an unexpected host object is not serializable.
    }
    out.push({
      id: `${msg.id}:widget:${index}`,
      name,
      category,
      widgetType,
      arguments: args,
    });
  });
  return out;
}

function clientWidgetLabel(widget: ClientWidget): string {
  const category = widget.category ? ` · ${widget.category.toUpperCase()}` : "";
  return `${widget.name} · WIDGET${category}`;
}

function toolIdentity(
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
): Pick<AiToolCall, "provider" | "kind" | "source" | "operation"> {
  const directBuiltin = directBuiltinIdentity(tool);
  if (directBuiltin) return directBuiltin;

  const recallIdentity = recallToolIdentity(tool, state);
  if (recallIdentity) return recallIdentity;

  const candidates: ChatgptMessage[] = [tool];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id) continue;
    const related = belongsToToolCall(msg, tool, state);
    if (!related) continue;
    candidates.push(msg);
  }

  // First prefer definitive metadata emitted with the tool result. The
  // assistant's api_tool.call_tool path is only a fallback: it cannot tell us
  // whether an app is backed by MCP or by a normal connector/plugin.
  for (const msg of candidates) {
    const resource = isRecord(msg.metadata.invoked_resource) ? msg.metadata.invoked_resource : null;
    if (resource) {
      let provider =
        typeof resource.app_name === "string" && resource.app_name.trim()
          ? resource.app_name.trim()
          : undefined;
      const uri = typeof resource.resource_uri === "string" ? resource.resource_uri : "";
      if (!provider && uri.startsWith("/files/")) provider = "files";
      const kind: AiToolCall["kind"] = builtinProvider(provider) ? "builtin" : "app";
      const sdk = isRecord(msg.metadata.chatgpt_sdk) ? msg.metadata.chatgpt_sdk : null;
      const connectorType =
        typeof msg.metadata.connector_type === "string"
          ? msg.metadata.connector_type
          : sdk && typeof sdk.connector_type === "string"
            ? sdk.connector_type
            : undefined;
      return {
        provider,
        kind,
        source:
          kind === "app" &&
          (resource.contains_mcp_source === true || connectorType?.toUpperCase() === "MCP")
            ? "mcp"
            : undefined,
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
      return { provider: provider?.trim(), kind: "app", operation: operation?.trim() };
    }
  }

  for (const msg of candidates) {
    if (msg.role === "assistant" && msg.recipient === "api_tool.call_tool") {
      const path = connectorPathIdentity(msg.text);
      if (path.provider || path.operation) {
        const kind: AiToolCall["kind"] = builtinProvider(path.provider) ? "builtin" : "app";
        return {
          provider: path.provider,
          kind,
          source: kind === "app" && knownMcpProvider(state, path.provider) ? "mcp" : undefined,
          operation: path.operation,
        };
      }
    }
  }
  return {};
}

function observedReasoningBounds(state: ChatgptWebMergeState): {
  start?: number;
  end?: number;
} {
  let start: number | undefined;
  let end: number | undefined;
  const include = (value: number | undefined): void => {
    if (value == null || !Number.isFinite(value)) return;
    start = start == null ? value : Math.min(start, value);
    end = end == null ? value : Math.max(end, value);
  };
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg) continue;
    include(msg.observedAt);
    include(msg.observedUpdatedAt);
  }
  for (const transition of state.reasoningTransitions) include(transition.observedAt);
  return { start, end };
}

function reasoningStartTime(state: ChatgptWebMergeState): number | undefined {
  // Browser receive time is the primary clock for ChatGPT Web. Work frequently
  // leaves create_time/update_time null and may emit reasoning_start_time only
  // in one continuation segment, while receivedAt exists for every delta.
  const observed = observedReasoningBounds(state).start;
  if (observed != null) return observed;
  for (const id of state.order) {
    const msg = state.messages.get(id);
    const value = msg?.metadata.reasoning_start_time;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function reasoningDurationSec(state: ChatgptWebMergeState): number | undefined {
  const sessions = new Map<string, number>();
  for (const id of state.order) {
    const msg = state.messages.get(id);
    const value = msg?.metadata.finished_duration_sec;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const start = msg?.metadata.reasoning_start_time;
    const key = typeof start === "number" && Number.isFinite(start) ? String(start) : id;
    sessions.set(key, value);
  }
  if (sessions.size === 0) return undefined;
  return Array.from(sessions.values()).reduce((sum, value) => sum + value, 0);
}

function reasoningSessionStarts(state: ChatgptWebMergeState): number[] {
  const starts = new Set<number>();
  for (const id of state.order) {
    const value = state.messages.get(id)?.metadata.reasoning_start_time;
    if (typeof value === "number" && Number.isFinite(value)) starts.add(value);
  }
  return Array.from(starts).sort((a, b) => a - b);
}

function reasoningSessionClosed(state: ChatgptWebMergeState, start: number): boolean {
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.metadata.reasoning_start_time !== start) continue;
    if (
      (typeof msg.metadata.finished_duration_sec === "number" &&
        Number.isFinite(msg.metadata.finished_duration_sec)) ||
      (typeof msg.metadata.reasoning_end_time === "number" &&
        Number.isFinite(msg.metadata.reasoning_end_time)) ||
      msg.metadata.reasoning_status === "reasoning_ended"
    ) {
      return true;
    }
  }
  return false;
}

function inferredOpenReasoningTailSec(
  state: ChatgptWebMergeState,
  observation?: AiMergeObservation,
): number | undefined {
  if (
    observation?.endedAtMs == null ||
    !Number.isFinite(observation.endedAtMs) ||
    observation.streamStatus === "streaming"
  ) {
    return undefined;
  }
  const latestStart = reasoningSessionStarts(state).at(-1);
  if (latestStart == null || reasoningSessionClosed(state, latestStart)) return undefined;
  const observedEndSec = observation.endedAtMs / 1000;
  if (!Number.isFinite(observedEndSec) || observedEndSec < latestStart) return undefined;
  return observedEndSec - latestStart;
}

function reasoningDurationInfo(
  state: ChatgptWebMergeState,
  observation?: AiMergeObservation,
): { duration?: number; kind?: "measured" | "inferred" } {
  const observed = observedReasoningBounds(state);
  if (observed.start != null) {
    const observedEnd =
      observation?.endedAtMs != null &&
      Number.isFinite(observation.endedAtMs) &&
      observation.streamStatus !== "streaming"
        ? observation.endedAtMs / 1000
        : observed.end;
    if (observedEnd != null && observedEnd >= observed.start) {
      return {
        duration: observedEnd - observed.start,
        kind: observation?.streamStatus === "streaming" ? "inferred" : "measured",
      };
    }
  }
  const measured = reasoningDurationSec(state);
  const inferredTail = inferredOpenReasoningTailSec(state, observation);
  if (inferredTail != null) {
    return { duration: (measured ?? 0) + inferredTail, kind: "inferred" };
  }
  return measured == null ? {} : { duration: measured, kind: "measured" };
}

function reasoningElapsedSec(msg: ChatgptMessage, start?: number): number | undefined {
  if (start == null) return undefined;
  const timestamp =
    msg.observedAt != null && Number.isFinite(msg.observedAt) ? msg.observedAt : msg.createdAt;
  if (timestamp == null || !Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - start);
}

function reasoningElapsedSecWithFallback(
  msg: ChatgptMessage,
  state: ChatgptWebMergeState,
  start?: number,
): number | undefined {
  const own = reasoningElapsedSec(msg, start);
  if (own != null) return own;

  for (const id of referencedMessageIds(msg)) {
    const referenced = state.messages.get(id);
    if (!referenced) continue;
    const elapsed = reasoningElapsedSec(referenced, start);
    if (elapsed != null) return elapsed;
  }

  let next = parentId(msg);
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const parent = state.messages.get(next);
    if (!parent) break;
    const elapsed = reasoningElapsedSec(parent, start);
    if (elapsed != null) return elapsed;
    next = parentId(parent);
  }
  return undefined;
}

function messageCompletionElapsedSec(msg: ChatgptMessage, start?: number): number | undefined {
  if (start == null) return undefined;
  const completedAt =
    msg.observedUpdatedAt != null && Number.isFinite(msg.observedUpdatedAt)
      ? msg.observedUpdatedAt
      : msg.observedAt != null && Number.isFinite(msg.observedAt)
        ? msg.observedAt
        : msg.updatedAt != null && Number.isFinite(msg.updatedAt)
          ? msg.updatedAt
          : msg.createdAt;
  if (completedAt == null || !Number.isFinite(completedAt)) return undefined;
  return Math.max(0, completedAt - start);
}

function measuredLogicalToolDurationSec(
  tool: ChatgptMessage,
  state: ChatgptWebMergeState,
  start?: number,
): number | undefined {
  const toolStart = reasoningElapsedSec(tool, start);
  if (toolStart == null) return undefined;

  let completed: number | undefined;
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id || msg.role !== "tool") continue;
    if (!belongsToToolCall(msg, tool, state)) continue;
    const elapsed = messageCompletionElapsedSec(msg, start);
    if (elapsed == null || elapsed < toolStart) continue;
    completed = completed == null ? elapsed : Math.max(completed, elapsed);
  }
  return completed == null ? undefined : Math.max(0, completed - toolStart);
}

function reasoningEndElapsedSec(
  state: ChatgptWebMergeState,
  start?: number,
  observation?: AiMergeObservation,
): number | undefined {
  if (start == null) return undefined;
  const observed = observedReasoningBounds(state);
  const observedEnd =
    observation?.endedAtMs != null &&
    Number.isFinite(observation.endedAtMs) &&
    observation.streamStatus !== "streaming"
      ? observation.endedAtMs / 1000
      : observed.end;
  if (observedEnd != null && observedEnd >= start) return observedEnd - start;
  const latestStart = reasoningSessionStarts(state).at(-1);
  if (
    latestStart != null &&
    !reasoningSessionClosed(state, latestStart) &&
    observation?.endedAtMs != null &&
    Number.isFinite(observation.endedAtMs) &&
    observation.streamStatus !== "streaming"
  ) {
    const observedEnd = observation.endedAtMs / 1000;
    if (observedEnd >= latestStart) return Math.max(0, observedEnd - start);
  }
  let max: number | undefined;
  const reasoningStarts = new Set<number>();
  for (const id of state.order) {
    const msg = state.messages.get(id);
    const sessionStart = msg?.metadata.reasoning_start_time;
    if (typeof sessionStart === "number" && Number.isFinite(sessionStart)) {
      reasoningStarts.add(sessionStart);
    }
    const end = msg?.metadata.reasoning_end_time;
    if (typeof end !== "number" || !Number.isFinite(end)) continue;
    const elapsed = Math.max(0, end - start);
    max = max == null ? elapsed : Math.max(max, elapsed);
  }
  if (max != null) return max;
  // finished_duration_sec is a duration, not an absolute boundary. It can be
  // used as a fallback only for a single reasoning session; summing multiple
  // resumed sessions and treating that sum as an offset from the first start
  // would fabricate a timestamp.
  return reasoningStarts.size <= 1 ? reasoningDurationSec(state) : undefined;
}

function reasoningTimePrefix(elapsedSec?: number): string {
  return elapsedSec == null ? "" : `+${elapsedSec.toFixed(1)}s  `;
}

function reasoningTitle(msg: ChatgptMessage): string {
  const explicit = cleanReasoningStatus(msg.metadata.reasoning_title);
  if (explicit) return explicit;
  const dil = isRecord(msg.metadata.dil_v2_reasoning) ? msg.metadata.dil_v2_reasoning : null;
  const appData = dil && isRecord(dil.appData) ? dil.appData : null;
  return cleanReasoningStatus(appData?.current_status) || cleanReasoningStatus(appData?.title);
}

function isPlaceholderReasoningSummary(text: string): boolean {
  return !cleanReasoningStatus(text);
}

function referencedMessageIds(msg: ChatgptMessage): string[] {
  const ids: string[] = [];
  if (msg.sourceAnalysisMessageId) ids.push(msg.sourceAnalysisMessageId);
  const inline = isRecord(msg.metadata.inline_cot_expandable_content)
    ? msg.metadata.inline_cot_expandable_content
    : null;
  if (inline && Array.isArray(inline.source_message_ids)) {
    for (const id of inline.source_message_ids) {
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function relatedLogicalTool(
  msg: ChatgptMessage,
  state: ChatgptWebMergeState,
): ChatgptMessage | undefined {
  if (isLogicalToolCall(msg)) return msg;
  for (const id of referencedMessageIds(msg)) {
    const referenced = state.messages.get(id);
    if (!referenced) continue;
    if (isLogicalToolCall(referenced)) return referenced;
    const parent = logicalToolParent(referenced, state);
    if (parent) return parent;
  }
  return logicalToolParent(msg, state);
}

function toolContextLabel(tool: ChatgptMessage, state: ChatgptWebMergeState): string {
  if (tool.recipient === "web.run") {
    return `web.run · ${webRunOperation(searchDetailsForTool(tool, state))}`;
  }
  if (tool.recipient === "python") return "python · BUILTIN";
  const identity = toolIdentity(tool, state);
  const ui = toolUiDetails(tool, state);
  const provider = identity.provider ?? tool.recipient ?? "tool";
  const kind = identity.kind ? ` · ${identity.kind.toUpperCase()}` : "";
  const source = identity.source ? ` · ${identity.source.toUpperCase()}` : "";
  const presentation = ui.presentation === "app_ui" ? " · UI" : "";
  const operation = identity.operation ? ` · ${identity.operation}` : "";
  return `${provider}${kind}${source}${presentation}${operation}`;
}

function logicalToolStageTitle(tool: ChatgptMessage, state: ChatgptWebMergeState): string {
  const own = reasoningTitle(tool);
  if (own) return own;
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id || !belongsToToolCall(msg, tool, state)) continue;
    // Only inherit a title from the tool's transport/result/summary chain.
    // User-visible commentary can be a later phase descended from the tool;
    // letting it rename the earlier tool retroactively shifts stage timing.
    const isToolChainMetadata =
      msg.role === "tool" ||
      msg.recipient === "api_tool.call_tool" ||
      msg.contentType === "thoughts" ||
      msg.contentType === "reasoning_recap" ||
      msg.metadata.is_visually_hidden_from_conversation === true;
    if (!isToolChainMetadata) continue;
    const title = reasoningTitle(msg);
    if (title) return title;
  }
  return "";
}

function reasoningStageTitle(msg: ChatgptMessage, state: ChatgptWebMergeState): string {
  const own = reasoningTitle(msg);
  if (own) return own;

  const tool = relatedLogicalTool(msg, state);
  if (tool) {
    const title = logicalToolStageTitle(tool, state);
    if (title) return title;
  }

  let next = parentId(msg);
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const parent = state.messages.get(next);
    if (!parent) break;
    const title = reasoningTitle(parent);
    if (title) return title;
    next = parentId(parent);
  }
  return "";
}

function reasoningStages(
  state: ChatgptWebMergeState,
  observation?: AiMergeObservation,
): AiReasoningStage[] {
  const stages: AiReasoningStage[] = [];
  const seenTools = new Set<string>();
  const start = reasoningStartTime(state);
  let current: AiReasoningStage | undefined;
  let currentClosed = false;

  const createStage = (title: string, msg: ChatgptMessage): AiReasoningStage => {
    const stage: AiReasoningStage = {
      id: msg.id,
      title,
      elapsedSec: reasoningElapsedSecWithFallback(msg, state, start),
      items: [],
    };
    stages.push(stage);
    current = stage;
    currentClosed = false;
    return stage;
  };

  const stageFor = (
    msg: ChatgptMessage,
    title: string,
    preferExisting: boolean,
  ): AiReasoningStage => {
    if (title) {
      if (current?.title === title && (!currentClosed || preferExisting)) return current;
      if (preferExisting) {
        for (let i = stages.length - 1; i >= 0; i -= 1) {
          if (stages[i]!.title === title) return stages[i]!;
        }
      }
      return createStage(title, msg);
    }
    if (current && !currentClosed) return current;
    return createStage("", msg);
  };

  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg) continue;

    const transitions = state.reasoningTransitions.filter((item) => item.messageId === msg.id);
    for (const transition of transitions) {
      const elapsedSec =
        start != null && transition.observedAt != null
          ? Math.max(0, transition.observedAt - start)
          : reasoningElapsedSecWithFallback(msg, state, start);
      const stage = stageFor(msg, transition.text, false);
      stage.elapsedSec = elapsedSec;
      stage.items.push({
        kind: "summary",
        text: transition.text,
        elapsedSec,
        sourceMessageId: msg.id,
      });
    }

    for (const toolEvent of state.dilToolEvents.filter((item) => item.messageId === msg.id)) {
      const elapsedSec =
        start != null && toolEvent.observedAt != null
          ? Math.max(0, toolEvent.observedAt - start)
          : reasoningElapsedSecWithFallback(msg, state, start);
      const stage = stageFor(msg, reasoningStageTitle(msg, state), true);
      stage.items.push({
        kind: "tool",
        text: dilToolLabel(toolEvent),
        elapsedSec,
        sourceMessageId: msg.id,
        toolId: toolEvent.id,
      });
    }

    const title = reasoningTitle(msg);
    // Only events that actually *start* visible work should advance the
    // current stage. Tool summaries/results often arrive later with
    // create_time=null and repeat an earlier reasoning_title; eagerly creating
    // a stage for those produces duplicate title-only cards with no timestamp.
    const startsVisibleStage =
      isRenderableToolCall(msg, state) ||
      (msg.role === "assistant" &&
        msg.contentType === "text" &&
        (msg.channel === "commentary" || msg.metadata.is_thinking_preamble_message === true) &&
        Boolean(msg.text));
    if (title && startsVisibleStage && current?.title !== title) {
      createStage(title, msg);
    }

    if (isRenderableToolCall(msg, state)) {
      const identity = toolIdentity(msg, state);
      const args = connectorPayloadForTool(msg, state);
      const isEmptyHiddenWrapper =
        msg.metadata.is_visually_hidden_from_conversation === true &&
        msg.recipient === "functions.exec" &&
        !identity.provider &&
        !identity.operation &&
        (!args || args === "{}");
      if (isEmptyHiddenWrapper) continue;
      if (!seenTools.has(msg.id)) {
        seenTools.add(msg.id);
        const inheritedTitle = logicalToolStageTitle(msg, state) || title;
        const toolTitle =
          inheritedTitle ||
          (!current || current.title === "进度" ? toolContextLabel(msg, state) : "");
        const stage = stageFor(msg, toolTitle, false);
        let label = toolContextLabel(msg, state);
        if (msg.recipient === "web.run") {
          const search = searchDetailsForTool(msg, state);
          const bits: string[] = [];
          if (search.queries.length > 0) bits.push(`${search.queries.length} 个查询`);
          if (search.results.length > 0) bits.push(`${search.results.length} 个结果`);
          if (bits.length > 0) label += ` · ${bits.join(" / ")}`;
        }
        const measuredDuration = measuredLogicalToolDurationSec(msg, state, start);
        stage.items.push({
          kind: "tool",
          text: label,
          elapsedSec: reasoningElapsedSecWithFallback(msg, state, start),
          durationSec: measuredDuration,
          durationKind: measuredDuration == null ? undefined : "measured",
          sourceMessageId: msg.id,
          toolId: msg.id,
        });
      }
      continue;
    }

    if (isStandaloneWebToolResult(msg, state) && !seenTools.has(msg.id)) {
      seenTools.add(msg.id);
      const search = standaloneWebSearchDetails(msg, state);
      let label = `web.run · ${directWebRunOperation(msg)}`;
      const bits: string[] = [];
      if (search.queries.length > 0) bits.push(`${search.queries.length} 个查询`);
      if (search.results.length > 0) bits.push(`${search.results.length} 个结果`);
      if (bits.length > 0) label += ` · ${bits.join(" / ")}`;
      const inheritedTitle = reasoningStageTitle(msg, state) || title;
      const stage = stageFor(
        msg,
        inheritedTitle || (!current || current.title === "进度" ? label : ""),
        false,
      );
      stage.items.push({
        kind: "tool",
        text: label,
        elapsedSec: reasoningElapsedSecWithFallback(msg, state, start),
        sourceMessageId: msg.id,
        toolId: msg.id,
      });
      continue;
    }

    const widgets = clientWidgetsFromMessage(msg);
    if (widgets.length > 0) {
      const stage = stageFor(msg, reasoningStageTitle(msg, state), true);
      for (const widget of widgets) {
        stage.items.push({
          kind: "tool",
          text: clientWidgetLabel(widget),
          elapsedSec: reasoningElapsedSecWithFallback(msg, state, start),
          sourceMessageId: msg.id,
          toolId: widget.id,
        });
      }
    }

    if (msg.metadata.is_visually_hidden_from_conversation === true) continue;

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
      const fallbackTitle = msg.metadata.is_thinking_preamble_message === true ? "进度" : "";
      const stage = stageFor(msg, reasoningStageTitle(msg, state) || fallbackTitle, false);
      stage.items.push({
        kind: "commentary",
        text: msg.text,
        elapsedSec: reasoningElapsedSecWithFallback(msg, state, start),
        sourceMessageId: msg.id,
      });
      continue;
    }
    if (
      (msg.contentType === "reasoning_recap" || msg.contentType === "thoughts") &&
      msg.reasoningSummary
    ) {
      if (msg.contentType === "thoughts" && transitions.length > 0) continue;
      let summaryStage: AiReasoningStage | undefined;
      for (const summary of msg.reasoningSummary
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (isPlaceholderReasoningSummary(summary)) continue;
        const isDurationOnly = /^思考了\s+(?:\d+(?:\.\d+)?[hms]\s*)+$/i.test(summary);
        if (isDurationOnly) continue;
        const stage = stageFor(msg, reasoningStageTitle(msg, state), true);
        summaryStage = stage;
        stage.items.push({
          kind: "summary" as const,
          text: summary,
          elapsedSec: reasoningElapsedSec(msg, start),
          sourceMessageId: msg.id,
        });
      }
      // ChatGPT does not emit a dedicated per-stage close event. Tool-bound
      // summaries are the reliable local boundary: they either point back to
      // the tool through source_message_ids / parent ancestry or carry tool
      // summary metadata. Close only those stages, not ordinary reasoning
      // summaries, otherwise unrelated thoughts would fragment the timeline.
      const summarizedTool = relatedLogicalTool(msg, state);
      if (summaryStage && current === summaryStage && summarizedTool) currentClosed = true;
    }
  }

  // A reasoning_title can also be emitted on bookkeeping/result messages that
  // have no user-visible detail. Do not render those as fake-expandable cards.
  const visibleStages = stages.filter((stage) => stage.items.length > 0);
  const orderIndex = new Map(state.order.map((id, index) => [id, index]));
  const activeItems = visibleStages
    .flatMap((stage) => stage.items)
    .filter(
      (item) => item.kind !== "summary" && item.elapsedSec != null && item.sourceMessageId != null,
    )
    .sort((a, b) => {
      const elapsed = (a.elapsedSec ?? 0) - (b.elapsedSec ?? 0);
      if (elapsed !== 0) return elapsed;
      return (
        (orderIndex.get(a.sourceMessageId ?? "") ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(b.sourceMessageId ?? "") ?? Number.MAX_SAFE_INTEGER)
      );
    });
  const reasoningEnd = reasoningEndElapsedSec(state, start, observation);

  for (let index = 0; index < activeItems.length; index += 1) {
    const item = activeItems[index]!;
    if (item.durationSec != null) continue;
    const itemStart = item.elapsedSec!;
    const nextStart = activeItems[index + 1]?.elapsedSec;
    const inferredEnd = nextStart != null ? nextStart : reasoningEnd;
    if (inferredEnd == null || inferredEnd < itemStart) continue;
    item.durationSec = Math.max(0, inferredEnd - itemStart);
    item.durationKind = "inferred";
  }

  visibleStages.forEach((stage, index) => {
    if (stage.elapsedSec == null) return;
    let end = stage.elapsedSec;
    for (const item of stage.items) {
      if (item.elapsedSec == null) continue;
      end = Math.max(end, item.elapsedSec);
      if (item.durationSec != null) end = Math.max(end, item.elapsedSec + item.durationSec);
    }
    const nextStageStart = visibleStages[index + 1]?.elapsedSec;
    if (nextStageStart != null && nextStageStart >= stage.elapsedSec) {
      end = Math.max(end, nextStageStart);
    }
    if (index === visibleStages.length - 1 && reasoningEnd != null) {
      end = Math.max(end, reasoningEnd);
    }
    stage.durationSec = Math.max(0, end - stage.elapsedSec);
    stage.durationKind = "inferred";
  });

  return visibleStages;
}

function visibleReasoningText(
  stages: AiReasoningStage[],
  duration?: number,
  durationKind?: "measured" | "inferred",
): string {
  const out: string[] = [];
  for (const stage of stages) {
    const stageTitle = stage.title || "准备";
    const stageDuration = stage.durationSec == null ? "" : ` · ≈${stage.durationSec.toFixed(1)}s`;
    out.push(`${reasoningTimePrefix(stage.elapsedSec)}阶段 · ${stageTitle}${stageDuration}`);
    for (const item of stage.items) {
      const prefix = item.kind === "commentary" ? "说明" : item.kind === "tool" ? "工具" : "摘要";
      const itemDuration =
        item.durationSec == null
          ? ""
          : ` · ${item.durationKind === "inferred" ? "≈" : "耗时 "}${item.durationSec.toFixed(1)}s`;
      out.push(`${reasoningTimePrefix(item.elapsedSec)}${prefix} · ${item.text}${itemDuration}`);
    }
  }

  if (duration != null) {
    out.push(
      `总思考时间：${durationKind === "inferred" ? `≈${duration.toFixed(1)}s` : `${duration}s`}`,
    );
  }
  return out.join("\n\n");
}

function toolCalls(state: ChatgptWebMergeState): AiToolCall[] {
  const out: AiToolCall[] = [];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg) continue;

    if (isStandaloneWebToolResult(msg, state)) {
      const search = standaloneWebSearchDetails(msg, state);
      const operation = directWebRunOperation(msg);
      out.push({
        index: out.length,
        id: msg.id,
        name: "web.run",
        provider: "web.run",
        kind: "search",
        operation,
        arguments: JSON.stringify({
          type: operation,
          queries: search.queries,
          results: search.results,
        }),
      });
      continue;
    }

    if (msg.role !== "assistant") continue;

    if (msg.recipient && msg.recipient !== "all") {
      if (!(msg.recipient === "api_tool.call_tool" && logicalToolParent(msg, state))) {
        let args = connectorPayloadForTool(msg, state);
        let identity = toolIdentity(msg, state);
        if (msg.recipient === "web.run") {
          const search = searchDetailsForTool(msg, state);
          identity = {
            provider: "web.run",
            kind: "search",
            operation: webRunOperation(search),
          };
        } else if (msg.recipient === "python") {
          identity = { provider: "python", kind: "builtin" };
        }
        const isEmptyHiddenWrapper =
          msg.metadata.is_visually_hidden_from_conversation === true &&
          msg.recipient === "functions.exec" &&
          !identity.provider &&
          !identity.operation &&
          (!args || args === "{}");
        if (!isEmptyHiddenWrapper) {
          if (!identity.kind && msg.recipient === "functions.exec") {
            identity = {
              ...identity,
              provider: identity.provider ?? "functions.exec",
              kind: "builtin",
            };
          }
          if (msg.recipient === "web.run") {
            const search = searchDetailsForTool(msg, state);
            if (search.queries.length > 0 || search.results.length > 0) {
              const operation = webRunOperation(search);
              args = JSON.stringify({
                type: operation,
                queries: search.queries,
                results: search.results,
              });
            }
          }
          out.push({
            index: out.length,
            id: msg.id,
            name: msg.recipient,
            ...identity,
            ...toolUiDetails(msg, state),
            arguments: args || "{}",
          });
        }
      }
    }

    for (const widget of clientWidgetsFromMessage(msg)) {
      out.push({
        index: out.length,
        id: widget.id,
        name: widget.name,
        provider: widget.name,
        kind: "widget",
        presentation: "client_widget",
        widgetCategory: widget.category,
        widgetType: widget.widgetType,
        arguments: widget.arguments,
      });
    }
  }

  const explicitCounts = new Map<string, number>();
  for (const tool of out) {
    const key = `${tool.provider ?? tool.name ?? ""}:${tool.operation ?? ""}`.toLowerCase();
    explicitCounts.set(key, (explicitCounts.get(key) ?? 0) + 1);
  }
  const consumed = new Map<string, number>();
  for (const event of state.dilToolEvents) {
    if (out.some((tool) => tool.id === event.id)) continue;
    const identity = dilToolIdentity(event);
    const key = `${identity.provider ?? ""}:${identity.operation ?? ""}`.toLowerCase();
    const used = consumed.get(key) ?? 0;
    const explicit = explicitCounts.get(key) ?? 0;
    if (used < explicit) {
      consumed.set(key, used + 1);
      continue;
    }
    out.push({
      index: out.length,
      id: event.id,
      name: event.toolName ?? event.label ?? "tool",
      ...identity,
      arguments: "{}",
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
    reasoningTransitions: [],
    dilToolEvents: [],
  };
}

export function pushChatgptWeb(
  state: ChatgptWebMergeState,
  events: ReadonlyArray<Pick<SseEvent, "data" | "event"> & Partial<Pick<SseEvent, "receivedAt">>>,
): void {
  for (const ev of events) {
    if (ev.event === "delta_encoding") continue;
    if (ev.data.trim() === "[DONE]") {
      state.endMeta.finishReason = state.endMeta.finishReason ?? "stop";
      continue;
    }
    const parsed = parseEventData(ev.data);
    if (!isRecord(parsed)) continue;
    if (parsed.type === "server_ste_metadata" && isRecord(parsed.metadata)) {
      applyChatgptMetadataToEndMeta(parsed.metadata, state);
    }
    if (parsed.type === "input_message" && isRecord(parsed.input_message)) {
      applyChatgptMetadataToEndMeta(
        isRecord(parsed.input_message.metadata) ? parsed.input_message.metadata : null,
        state,
      );
    }
    if (ev.event === "delta") {
      ingestDelta(parsed, state, ev.receivedAt);
      continue;
    }
    if (parsed.type === "message_stream_complete") {
      state.endMeta.finishReason = state.endMeta.finishReason ?? "stop";
    }
  }
}

export function snapshotChatgptWeb(
  state: ChatgptWebMergeState,
  observation?: AiMergeObservation,
): MergeChannelsResult {
  const stages = reasoningStages(state, observation);
  const duration = reasoningDurationInfo(state, observation);
  return {
    channels: {
      content: finalAssistantText(state),
      reasoning: visibleReasoningText(stages, duration.duration, duration.kind),
      tools: toolCalls(state),
      reasoningStages: stages,
      reasoningDurationSec: duration.duration,
      reasoningDurationKind: duration.kind,
    },
    endMeta: state.endMeta,
    chunkCount: state.chunkCount,
  };
}

export function mergeChatgptWeb(
  events: ReadonlyArray<Pick<SseEvent, "data" | "event">>,
  observation?: AiMergeObservation,
): MergeChannelsResult {
  const state = createChatgptWebMergeState();
  pushChatgptWeb(state, events);
  return snapshotChatgptWeb(state, observation);
}
