import type { AiReasoningItem, AiReasoningStage, AiToolCall } from "../../shared/ai-merge/types";

export function reasoningStageHasDetails(stage: AiReasoningStage): boolean {
  return stage.items.length > 0;
}

export function findReasoningToolIndex(
  item: Pick<AiReasoningItem, "toolId">,
  tools: ReadonlyArray<AiToolCall>,
): number {
  const id = item.toolId;
  if (!id) return -1;
  return tools.findIndex((tool) => tool.id === id || tool.aliases?.includes(id));
}
