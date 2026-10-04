import { describe, expect, it } from "vitest";
import type { AiReasoningStage, AiToolCall } from "../../../shared/ai-merge/types";
import { findReasoningToolIndex, reasoningStageHasDetails } from "../conversation-reasoning";

describe("conversation reasoning helpers", () => {
  it("does not mark an empty reasoning stage as expandable", () => {
    const stage: AiReasoningStage = {
      id: "stage-1",
      title: "Inspecting repositories",
      items: [],
    };
    expect(reasoningStageHasDetails(stage)).toBe(false);
    stage.items.push({ kind: "tool", text: "Devspace · APP · MCP · read", toolId: "dil-1" });
    expect(reasoningStageHasDetails(stage)).toBe(true);
  });

  it("resolves reasoning tool links through primary IDs and DIL aliases", () => {
    const tools: AiToolCall[] = [
      {
        index: 0,
        id: "jit-message-1",
        aliases: ["exec-123:integration"],
        provider: "Devspace",
        kind: "app",
        source: "mcp",
        operation: "read",
        arguments: "{}",
      },
    ];
    expect(findReasoningToolIndex({ toolId: "jit-message-1" }, tools)).toBe(0);
    expect(findReasoningToolIndex({ toolId: "exec-123:integration" }, tools)).toBe(0);
    expect(findReasoningToolIndex({ toolId: "missing" }, tools)).toBe(-1);
  });
});
