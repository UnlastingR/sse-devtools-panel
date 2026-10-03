import { describe, expect, it } from "vitest";
import { chatgptTurnIdentity, combineChatgptTurnRecords } from "../chatgpt-logical-turn";
import type { SseEvent, StreamRecord } from "../types";

function event(data: unknown, index = 0): SseEvent {
  return {
    event: "message",
    data: JSON.stringify(data),
    raw: "",
    index,
    receivedAt: index,
  };
}

function record(requestId: string, startedAt: number, events: SseEvent[]): StreamRecord {
  return {
    requestId,
    url: "https://chatgpt.com/backend-api/f/conversation",
    method: "POST",
    transport: "fetch",
    streamKind: "sse",
    startedAt,
    streamStatus: "done",
    raw: "",
    events,
  };
}

describe("ChatGPT logical turn grouping", () => {
  it("uses working_turn_id across a connector deny continuation", () => {
    const first = event({
      type: "input_message",
      conversation_id: "conv",
      input_message: { metadata: { turn_exchange_id: "turn-a", working_turn_id: "work" } },
    });
    const second = event({
      type: "input_message",
      conversation_id: "conv",
      input_message: {
        author: { role: "tool", name: "api_tool.call_tool" },
        metadata: {
          turn_exchange_id: "turn-b",
          working_turn_id: "work",
          jit_plugin_data: { from_client: { type: "deny" } },
        },
      },
    });

    expect(chatgptTurnIdentity([first])).toEqual({ conversationId: "conv", workingTurnId: "work" });
    expect(chatgptTurnIdentity([second])).toEqual({
      conversationId: "conv",
      workingTurnId: "work",
    });

    const a = record("a", 1, [first]);
    const b = record("b", 2, [second]);
    const merged = combineChatgptTurnRecords(b, [a, b]);
    expect(merged.requestId).toBe("chatgpt-turn:conv:work");
    expect(merged.events).toEqual([first, second]);
  });
});
