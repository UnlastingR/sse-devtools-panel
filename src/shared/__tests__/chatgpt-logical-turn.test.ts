import { describe, expect, it } from "vitest";
import {
  chatgptTurnIdentity,
  chatgptTurnKey,
  combineChatgptTurnRecords,
} from "../chatgpt-logical-turn";
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

function record(
  requestId: string,
  startedAt: number,
  events: SseEvent[],
  options: Partial<
    Pick<StreamRecord, "url" | "transport" | "streamStatus" | "errorMessage" | "endedAt">
  > = {},
): StreamRecord {
  return {
    requestId,
    url: options.url ?? "https://chatgpt.com/backend-api/f/conversation",
    method: "POST",
    transport: options.transport ?? "fetch",
    streamKind: "sse",
    startedAt,
    streamStatus: options.streamStatus ?? "done",
    errorMessage: options.errorMessage,
    endedAt: options.endedAt,
    raw: "",
    events,
  };
}

describe("ChatGPT logical turn grouping", () => {
  it("keeps Work approval continuations in separate turn generations", () => {
    const first = event({
      type: "input_message",
      conversation_id: "conv",
      input_message: {
        metadata: {
          turn_exchange_id: "turn-a",
          working_turn_id: "work",
          is_temporal_turn: true,
          stream_topic_id: "conversation-turn-work",
          async_source: "server:conversation-turn-work:US",
        },
      },
    });
    const second = event({
      type: "input_message",
      conversation_id: "conv",
      input_message: {
        author: { role: "tool", name: "api_tool.call_tool" },
        metadata: {
          turn_exchange_id: "turn-b",
          working_turn_id: "work",
          is_temporal_turn: true,
          stream_topic_id: "conversation-turn-work",
          async_source: "server:conversation-turn-work:US",
          jit_plugin_data: { from_client: { type: "deny" } },
        },
      },
    });

    expect(chatgptTurnIdentity([first])).toEqual({
      conversationId: "conv",
      workingTurnId: "work",
      turnExchangeId: "turn-a",
    });
    expect(chatgptTurnIdentity([second])).toEqual({
      conversationId: "conv",
      workingTurnId: "work",
      turnExchangeId: "turn-b",
    });

    const a = record("a", 1, [first], {
      url: "wss://ws.chatgpt.com/p21/ws/user/user-example#conversation-turn-work",
      transport: "websocket",
    });
    const b = record("b", 2, [second]);
    expect(chatgptTurnKey(a)).toBe("work:conv:turn-a");
    expect(chatgptTurnKey(b)).toBe("work:conv:turn-b");
    const merged = combineChatgptTurnRecords(b, [a, b]);
    expect(merged).toBe(b);
  });

  it("merges an interrupted conversation into a successful resume stream", () => {
    const first = event({
      type: "input_message",
      conversation_id: "conv",
      input_message: { metadata: { working_turn_id: "work" } },
    });
    const resumed = {
      ...event({
        v: {
          message: {
            metadata: { working_turn_id: "work" },
          },
        },
        conversation_id: "conv",
      }),
      event: "delta",
    };

    const interrupted = record("a", 1, [first], {
      streamStatus: "error",
      errorMessage: "network error",
      endedAt: 10,
    });
    const resume = record("b", 11, [resumed], {
      url: "https://chatgpt.com/backend-api/f/conversation/resume",
      streamStatus: "done",
      endedAt: 20,
    });

    const merged = combineChatgptTurnRecords(resume, [interrupted, resume]);
    expect(merged.requestId).toBe("chatgpt-turn:chat:conv:work");
    expect(merged.streamStatus).toBe("done");
    expect(merged.errorMessage).toBeUndefined();
    expect(merged.events).toEqual([first, resumed]);
  });

  it("recognizes ChatGPT Work WebSocket turn streams", () => {
    const wsEvent = event({
      v: {
        message: {
          metadata: {
            working_turn_id: "work",
            turn_exchange_id: "turn-a",
            is_temporal_turn: true,
            stream_topic_id: "conversation-turn-work",
            async_source: "server:conversation-turn-work:US",
          },
        },
      },
      conversation_id: "conv",
    });
    const ws = record("ws", 1, [wsEvent], {
      url: "wss://ws.chatgpt.com/p21/ws/user/user-example#conversation-turn-example",
      transport: "websocket",
    });

    expect(chatgptTurnKey(ws)).toBe("work:conv:turn-a");
    const merged = combineChatgptTurnRecords(ws, [ws]);
    expect(merged).toBe(ws);
    expect(chatgptTurnIdentity(ws.events)).toEqual({
      conversationId: "conv",
      workingTurnId: "work",
      turnExchangeId: "turn-a",
    });
  });
});
