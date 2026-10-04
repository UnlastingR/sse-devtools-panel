import type { AiProfile, AiProfileResult, AiVendorHint } from "../ai-profile";

export interface AiToolCall {
  index: number;
  id?: string;
  /** Alternate transport/DIL IDs that refer to the same logical tool call. */
  aliases?: string[];
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
  /** Whether arguments were actually present in/derived from the captured stream. */
  argumentsSource?: "stream" | "derived" | "missing";
}

export interface AiReasoningItem {
  kind: "activity" | "commentary" | "tool" | "summary";
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
  /** Stage boundaries are inferred from the reasoning timeline. */
  durationKind?: "inferred";
  items: AiReasoningItem[];
}

export interface AiConversationChannels {
  content: string;
  reasoning: string;
  tools: AiToolCall[];
  /** Structured ChatGPT reasoning timeline used by the collapsible UI. */
  reasoningStages?: AiReasoningStage[];
  reasoningDurationSec?: number;
  /** Whether the total reasoning duration is fully server-measured or includes an inferred tail. */
  reasoningDurationKind?: "measured" | "inferred";
}

export interface AiMergeObservation {
  /** Browser-observed transport end time in Unix milliseconds. */
  endedAtMs?: number;
  /** Physical/logical stream state at the time of the snapshot. */
  streamStatus?: "streaming" | "done" | "error";
  closeReason?: "complete" | "abort" | "error" | "http_error";
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
