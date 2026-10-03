import type { AiProfile, AiProfileResult, AiVendorHint } from "../ai-profile";

export interface AiToolCall {
  index: number;
  id?: string;
  name?: string;
  /** User-facing integration/tool name when the transport exposes it. */
  provider?: string;
  /** Product-level tool class. MCP is an APP source, not a peer type. */
  kind?: "app" | "builtin" | "search" | "widget";
  /** Optional implementation/source detail for an APP. */
  source?: "mcp";
  /** Concrete operation within the provider, e.g. read/apply_patch/exec_command. */
  operation?: string;
  /** Rich UI attached to a tool call or represented as a client-defined widget. */
  presentation?: "app_ui" | "client_widget";
  /** APP SDK ui:// resource for APP-owned cards. */
  uiResource?: string;
  /** Client-defined widget category such as map/visualization/app_block. */
  widgetCategory?: string;
  /** More specific widget implementation identifier when exposed by the stream. */
  widgetType?: string;
  arguments: string;
}

export interface AiReasoningItem {
  kind: "commentary" | "tool" | "summary";
  text: string;
  elapsedSec?: number;
  /** Independent duration for this item. Tool durations are measured when possible. */
  durationSec?: number;
  /** Whether durationSec came from an actual completion event or a timeline boundary. */
  durationKind?: "measured" | "inferred";
  /** Source ChatGPT message used internally to derive timing. */
  sourceMessageId?: string;
  /** Logical tool call ID used to jump from Reasoning to the matching Tools card. */
  toolId?: string;
}

export interface AiReasoningStage {
  id: string;
  /** Empty only for genuinely unclassified visible reasoning. */
  title: string;
  elapsedSec?: number;
  /** Independent wall-clock coverage of this stage. Stages may overlap. */
  durationSec?: number;
  items: AiReasoningItem[];
}

export interface AiConversationChannels {
  content: string;
  reasoning: string;
  tools: AiToolCall[];
  /** Structured ChatGPT reasoning timeline used by the collapsible UI. */
  reasoningStages?: AiReasoningStage[];
  reasoningDurationSec?: number;
}

export interface AiEndMeta {
  finishReason?: string;
  usage?: Record<string, unknown>;
  model?: string;
  thinkingEffort?: string;
}

export interface AiConversation {
  profile: AiProfile;
  vendorHint: AiVendorHint;
  detection: AiProfileResult;
  channels: AiConversationChannels;
  endMeta: AiEndMeta;
  /** Number of events that contributed a parseable AI chunk. */
  chunkCount: number;
}

export type MergeChannelsResult = {
  channels: AiConversationChannels;
  endMeta: AiEndMeta;
  chunkCount: number;
};
