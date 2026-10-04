import type { StreamRecord } from "../types";
import { resolveChatgptTurnGroup, type ChatgptTurnGroup } from "../chatgpt-logical-turn";
import { isChatgptConversationUrl } from "../ai-profile";
import { syncConversationMergeSession } from "./session";
import type { AiConversation, AiReasoningStage, AiToolCall } from "./types";

export type MergedChatgptTurn = {
  group: ChatgptTurnGroup;
  record: StreamRecord;
  conversation: AiConversation;
};

function shiftedStages(
  record: StreamRecord,
  baseStartedAt: number,
  conversation: AiConversation,
): AiReasoningStage[] {
  const shift = Math.max(0, (record.startedAt - baseStartedAt) / 1000);
  return (conversation.channels.reasoningStages ?? []).map((stage) => ({
    ...stage,
    id: `${record.requestId}:${stage.id}`,
    elapsedSec: stage.elapsedSec == null ? shift : shift + stage.elapsedSec,
    items: stage.items.map((item) => ({
      ...item,
      elapsedSec: item.elapsedSec == null ? shift : shift + item.elapsedSec,
    })),
  }));
}

function mergeTools(
  parts: Array<{ record: StreamRecord; conversation: AiConversation }>,
): AiToolCall[] {
  const out: AiToolCall[] = [];
  const seenIds = new Set<string>();
  for (const { record, conversation } of parts) {
    for (const tool of conversation.channels.tools) {
      const id = tool.id ?? `${record.requestId}:tool:${tool.index}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      out.push({ ...tool, id, index: out.length });
    }
  }
  return out;
}

function mergedReasoningDuration(
  parts: Array<{ record: StreamRecord; conversation: AiConversation }>,
  baseStartedAt: number,
): { duration?: number; kind?: "measured" | "inferred" } {
  const intervals: Array<{ start: number; end: number }> = [];
  let inferred = false;
  for (const { record, conversation } of parts) {
    const duration = conversation.channels.reasoningDurationSec;
    if (duration == null || !Number.isFinite(duration) || duration < 0) continue;
    const start = Math.max(0, (record.startedAt - baseStartedAt) / 1000);
    intervals.push({ start, end: start + duration });
    if (conversation.channels.reasoningDurationKind === "inferred") inferred = true;
  }
  if (intervals.length === 0) return {};
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let current = { ...intervals[0]! };
  for (const next of intervals.slice(1)) {
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
      continue;
    }
    total += Math.max(0, current.end - current.start);
    current = { ...next };
  }
  total += Math.max(0, current.end - current.start);
  return { duration: total, kind: inferred ? "inferred" : "measured" };
}

export function mergeChatgptTurnGroup(
  selected: StreamRecord,
  records: Iterable<StreamRecord>,
): MergedChatgptTurn | null {
  const group = resolveChatgptTurnGroup(selected, records);
  if (!group) return null;
  const parts = group.records
    .filter((record) => isChatgptConversationUrl(record.url))
    .map((record) => ({
      record,
      conversation: syncConversationMergeSession(record.requestId, record.events, record.url, {
        endedAtMs: record.endedAt,
        streamStatus: record.streamStatus,
        closeReason: record.closeReason,
      }),
    }));
  if (parts.length === 0) return null;

  const first = group.records[0]!;
  const last = group.records.at(-1)!;
  const anyStreaming = group.records.some((record) => record.streamStatus === "streaming");
  const content =
    [...parts]
      .reverse()
      .map((part) => part.conversation.channels.content)
      .find(Boolean) ?? "";
  const reasoningStages = parts.flatMap((part) =>
    shiftedStages(part.record, first.startedAt, part.conversation),
  );
  const duration = mergedReasoningDuration(parts, first.startedAt);
  const reasoning = Array.from(
    new Set(parts.map((part) => part.conversation.channels.reasoning).filter(Boolean)),
  ).join("\n\n");
  const tools = mergeTools(parts);
  const latestEndMeta = parts.reduce(
    (acc, part) => ({ ...acc, ...part.conversation.endMeta }),
    {} as AiConversation["endMeta"],
  );

  const conversation: AiConversation = {
    ...parts.at(-1)!.conversation,
    profile: group.profile,
    detection: { ...parts.at(-1)!.conversation.detection, profile: group.profile, matched: true },
    channels: {
      content,
      reasoning,
      tools,
      reasoningStages,
      reasoningDurationSec: duration.duration,
      reasoningDurationKind: duration.kind,
    },
    endMeta: latestEndMeta,
    chunkCount: parts.reduce((sum, part) => sum + part.conversation.chunkCount, 0),
  };

  const logicalStatus = anyStreaming ? "streaming" : last.streamStatus;
  const record: StreamRecord = {
    ...selected,
    requestId: `chatgpt-mother:${group.key}`,
    startedAt: first.startedAt,
    endedAt: anyStreaming ? undefined : last.endedAt,
    streamStatus: logicalStatus,
    closeReason: anyStreaming ? undefined : last.closeReason,
    errorMessage: logicalStatus === "error" ? last.errorMessage : undefined,
    raw: "",
    events: [],
  };
  return { group, record, conversation };
}
