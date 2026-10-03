import type { AiProfile, AiProfileResult, AiVendorHint } from "../ai-profile";

export interface AiToolCall {
  index: number;
  id?: string;
  name?: string;
  /** User-facing app/plugin/MCP name when the transport exposes it. */
  provider?: string;
  /** How the external tool is connected. */
  source?: "mcp" | "plugin" | "builtin";
  /** Concrete operation within the provider, e.g. read/apply_patch/exec_command. */
  operation?: string;
  arguments: string;
}

export interface AiConversationChannels {
  content: string;
  reasoning: string;
  tools: AiToolCall[];
}

export interface AiEndMeta {
  finishReason?: string;
  usage?: Record<string, unknown>;
  model?: string;
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
