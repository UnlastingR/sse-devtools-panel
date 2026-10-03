import type { SseEvent } from "../types";
import type { AiEndMeta, AiReasoningStage, AiToolCall, MergeChannelsResult } from "./types";
import { isRecord, parseEventData } from "./helpers";

type ChatgptMessage = {
  id: string;
  role: string;
  authorName?: string;
  createdAt?: number;
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
  const rawContent = isRecord(raw.content) ? raw.content : null;
  const metadata = isRecord(raw.metadata) ? { ...raw.metadata } : {};
  const existing = state.messages.get(raw.id);
  const msg: ChatgptMessage = {
    id: raw.id,
    role,
    authorName: author && typeof author.name === "string" ? author.name : existing?.authorName,
    createdAt: typeof raw.create_time === "number" ? raw.create_time : existing?.createdAt,
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

  const model = msg.metadata.resolved_model_slug ?? msg.metadata.model_slug;
  if (typeof model === "string") state.endMeta.model = model;
  if (typeof msg.metadata.thinking_effort === "string") {
    state.endMeta.thinkingEffort = msg.metadata.thinking_effort;
  }
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
    if (typeof msg.metadata.thinking_effort === "string") {
      state.endMeta.thinkingEffort = msg.metadata.thinking_effort;
    }
    return;
  }
  const metadataPrefix = "/message/metadata/";
  if (
    path.startsWith(metadataPrefix) &&
    (op === "add" || op === "replace" || op === "append" || op === "remove")
  ) {
    applyMetadataPath(msg.metadata, path.slice(metadataPrefix.length), op, value);
    if (path === "/message/metadata/thinking_effort" && typeof value === "string") {
      state.endMeta.thinkingEffort = value;
    }
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
  return msg.role === "tool" && msg.authorName === "web.run" && !webToolCallAncestor(msg, state);
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
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg || msg.id === tool.id || !sameChatgptTurn(msg, tool)) continue;
    ingest(msg);
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
    if (!msg || msg.id === tool.id || !belongsToLogicalTool(msg, tool, state)) continue;
    candidates.push(msg);
  }

  for (const msg of candidates) {
    const sdk = isRecord(msg.metadata.chatgpt_sdk) ? msg.metadata.chatgpt_sdk : null;
    const pointer = sdk && typeof sdk.html_asset_pointer === "string" ? sdk.html_asset_pointer : "";
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
    if (!msg || msg.id === tool.id || !belongsToLogicalTool(msg, tool, state)) continue;
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
      return {
        provider,
        kind,
        source: kind === "app" && resource.contains_mcp_source === true ? "mcp" : undefined,
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

function reasoningStartTime(state: ChatgptWebMergeState): number | undefined {
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

function reasoningElapsedSec(msg: ChatgptMessage, start?: number): number | undefined {
  if (start == null || msg.createdAt == null || !Number.isFinite(msg.createdAt)) return undefined;
  return Math.max(0, msg.createdAt - start);
}

function reasoningTimePrefix(elapsedSec?: number): string {
  return elapsedSec == null ? "" : `+${elapsedSec.toFixed(1)}s  `;
}

function reasoningTitle(msg: ChatgptMessage): string {
  return typeof msg.metadata.reasoning_title === "string"
    ? msg.metadata.reasoning_title.trim()
    : "";
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
  if (tool.recipient === "web.run") return "web.run · SEARCH";
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
    if (!msg || msg.id === tool.id || !belongsToLogicalTool(msg, tool, state)) continue;
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

function reasoningStages(state: ChatgptWebMergeState): AiReasoningStage[] {
  const stages: AiReasoningStage[] = [];
  const seenTools = new Set<string>();
  const start = reasoningStartTime(state);
  let current: AiReasoningStage | undefined;
  let currentClosed = false;

  const createStage = (title: string, msg: ChatgptMessage): AiReasoningStage => {
    const stage: AiReasoningStage = {
      id: msg.id,
      title,
      elapsedSec: reasoningElapsedSec(msg, start),
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

    const title = reasoningTitle(msg);
    // Only events that actually *start* visible work should advance the
    // current stage. Tool summaries/results often arrive later with
    // create_time=null and repeat an earlier reasoning_title; eagerly creating
    // a stage for those produces duplicate title-only cards with no timestamp.
    const startsVisibleStage =
      isLogicalToolCall(msg) ||
      (msg.role === "assistant" &&
        msg.contentType === "text" &&
        (msg.channel === "commentary" || msg.metadata.is_thinking_preamble_message === true) &&
        Boolean(msg.text));
    if (title && startsVisibleStage && current?.title !== title) {
      createStage(title, msg);
    }

    if (isLogicalToolCall(msg)) {
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
        const toolTitle = logicalToolStageTitle(msg, state) || title;
        const stage = stageFor(msg, toolTitle, false);
        let label = toolContextLabel(msg, state);
        if (msg.recipient === "web.run") {
          const search = searchDetailsForTool(msg, state);
          const bits: string[] = [];
          if (search.queries.length > 0) bits.push(`${search.queries.length} 个查询`);
          if (search.results.length > 0) bits.push(`${search.results.length} 个结果`);
          if (bits.length > 0) label += ` · ${bits.join(" / ")}`;
        }
        stage.items.push({
          kind: "tool",
          text: label,
          elapsedSec: reasoningElapsedSec(msg, start),
          toolId: msg.id,
        });
      }
      continue;
    }

    if (isStandaloneWebToolResult(msg, state) && !seenTools.has(msg.id)) {
      seenTools.add(msg.id);
      const stage = stageFor(msg, reasoningStageTitle(msg, state) || title, false);
      const search = standaloneWebSearchDetails(msg, state);
      let label = "web.run · SEARCH";
      const bits: string[] = [];
      if (search.queries.length > 0) bits.push(`${search.queries.length} 个查询`);
      if (search.results.length > 0) bits.push(`${search.results.length} 个结果`);
      if (bits.length > 0) label += ` · ${bits.join(" / ")}`;
      stage.items.push({
        kind: "tool",
        text: label,
        elapsedSec: reasoningElapsedSec(msg, start),
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
          elapsedSec: reasoningElapsedSec(msg, start),
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
      const stage = stageFor(msg, reasoningStageTitle(msg, state), false);
      stage.items.push({
        kind: "commentary",
        text: msg.text,
        elapsedSec: reasoningElapsedSec(msg, start),
      });
      continue;
    }
    if (
      (msg.contentType === "reasoning_recap" || msg.contentType === "thoughts") &&
      msg.reasoningSummary
    ) {
      let summaryStage: AiReasoningStage | undefined;
      for (const summary of msg.reasoningSummary
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const isDurationOnly = /^思考了\s+(?:\d+(?:\.\d+)?[hms]\s*)+$/i.test(summary);
        if (isDurationOnly) continue;
        const stage = stageFor(msg, reasoningStageTitle(msg, state), true);
        summaryStage = stage;
        stage.items.push({
          kind: "summary" as const,
          text: summary,
          elapsedSec: reasoningElapsedSec(msg, start),
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
  return stages.filter((stage) => stage.items.length > 0);
}

function visibleReasoningText(stages: AiReasoningStage[], duration?: number): string {
  const out: string[] = [];
  for (const stage of stages) {
    const stageTitle = stage.title || "准备";
    out.push(`${reasoningTimePrefix(stage.elapsedSec)}阶段 · ${stageTitle}`);
    for (const item of stage.items) {
      const prefix = item.kind === "commentary" ? "说明" : item.kind === "tool" ? "工具" : "摘要";
      out.push(`${reasoningTimePrefix(item.elapsedSec)}${prefix} · ${item.text}`);
    }
  }

  if (duration != null) out.push(`总思考时间：${duration}s`);
  return out.join("\n\n");
}

function toolCalls(state: ChatgptWebMergeState): AiToolCall[] {
  const out: AiToolCall[] = [];
  for (const id of state.order) {
    const msg = state.messages.get(id);
    if (!msg) continue;

    if (isStandaloneWebToolResult(msg, state)) {
      const search = standaloneWebSearchDetails(msg, state);
      out.push({
        index: out.length,
        id: msg.id,
        name: "web.run",
        provider: "web.run",
        kind: "search",
        arguments: JSON.stringify({
          type: "SEARCH",
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
          identity = { provider: "web.run", kind: "search" };
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
              args = JSON.stringify({
                type: "SEARCH",
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
  const stages = reasoningStages(state);
  const duration = reasoningDurationSec(state);
  return {
    channels: {
      content: finalAssistantText(state),
      reasoning: visibleReasoningText(stages, duration),
      tools: toolCalls(state),
      reasoningStages: stages,
      reasoningDurationSec: duration,
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
