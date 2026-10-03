import type { AiProfile, AiProfileResult, AiVendorHint } from "../ai-profile";

export interface AiToolCall {
  index: number;
  id?: string;
  name?: string;
  /** User-facing integration/tool name when the transport exposes it. */
  provider?: string;
  /** Product-level tool class. MCP is an APP source, not a peer type. */
  kind?: "app" | "builtin" | "search";
  /** Optional implementation/source detail for an APP. */
  source?: "mcp";
  /** Concrete operation within the provider, e.g. read/apply_patch/exec_command. */
  operation?: string;
  arguments: string;
}

export interface AiReasoningItem {
  kind: "commentary" | "tool" | "summary";
  text: string;
  elapsedSec?: number;
}

export interface AiReasoningStage {
  id: string;
  /** Empty only for genuinely unclassified visible reasoning. */
  title: string;
  elapsedSec?: number;
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
