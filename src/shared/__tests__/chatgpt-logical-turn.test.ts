import { describe, expect, it } from "vitest";
import {
  chatgptMotherTurnKey,
  chatgptTurnIdentity,
  chatgptTurnKey,
  combineChatgptTurnRecords,
  resolveChatgptTurnGroup,
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
    Pick<
      StreamRecord,
      "url" | "transport" | "streamStatus" | "errorMessage" | "endedAt" | "requestPayloadPreview"
    >
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
    requestPayloadPreview: options.requestPayloadPreview,
    raw: "",
    events,
  };
}

describe("ChatGPT logical turn grouping", () => {
  it("groups Work websocket and approval continuations under one mother turn", () => {
    const initial = record(
      "ws",
      1,
      [
        event({
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
        }),
      ],
      {
        url: "wss://ws.chatgpt.com/p21/ws/user/user-example#conversation-turn-work",
        transport: "websocket",
      },
    );
    const continuation = record("fetch-1", 2, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: {
          metadata: { turn_exchange_id: "turn-b", working_turn_id: "work" },
        },
      }),
    ]);
    const continuation2 = record("fetch-2", 3, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: {
          metadata: { turn_exchange_id: "turn-c", working_turn_id: "work" },
        },
      }),
    ]);
    const all = [initial, continuation, continuation2];
    const group = resolveChatgptTurnGroup(continuation, all);
    expect(group?.profile).toBe("chatgpt-web-work");
    expect(group?.records.map((item) => item.requestId)).toEqual(["ws", "fetch-1", "fetch-2"]);
    expect(chatgptMotherTurnKey(initial, all)).toBe(chatgptMotherTurnKey(continuation2, all));
  });

  it("keeps normal Chat follow-up turns as separate mother turns", () => {
    const first = record("chat-a", 1, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: { metadata: { turn_exchange_id: "a", working_turn_id: "a" } },
      }),
    ]);
    const followup = record("chat-b", 2, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: { metadata: { turn_exchange_id: "b", working_turn_id: "b" } },
      }),
    ]);
    expect(chatgptMotherTurnKey(first, [first, followup])).not.toBe(
      chatgptMotherTurnKey(followup, [first, followup]),
    );
  });

  it("attaches upload processing streams by file_id", () => {
    const conversation = record("conversation", 2, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: {
          metadata: {
            turn_exchange_id: "turn",
            working_turn_id: "turn",
            attachments: [{ id: "file_123" }],
          },
          content: {
            content_type: "multimodal_text",
            parts: [{ asset_pointer: "sediment://file_123" }, "hello"],
          },
        },
      }),
    ]);
    const upload = record("upload", 1, [event({ type: "file.processing.completed" })], {
      url: "https://chatgpt.com/backend-api/files/process_upload_stream",
      transport: "fetch",
      requestPayloadPreview: JSON.stringify({ file_id: "file_123", use_case: "agent" }),
    });
    const group = resolveChatgptTurnGroup(conversation, [upload, conversation]);
    expect(group?.records.map((item) => item.requestId)).toEqual(["upload", "conversation"]);
    expect(chatgptMotherTurnKey(upload, [upload, conversation])).toBe(group?.key);
  });

  it("attaches one physical upload only to the first Chat turn that references the file", () => {
    const upload = record("upload", 1, [event({ type: "file.processing.completed" })], {
      url: "https://chatgpt.com/backend-api/files/process_upload_stream",
      transport: "fetch",
      requestPayloadPreview: JSON.stringify({ file_id: "file_shared", use_case: "agent" }),
    });
    const first = record("chat-first", 2, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: {
          id: "msg-first",
          metadata: {
            turn_exchange_id: "turn-first",
            working_turn_id: "turn-first",
            attachments: [{ id: "file_shared" }],
          },
        },
      }),
    ]);
    const followup = record("chat-followup", 3, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: {
          id: "msg-followup",
          metadata: {
            turn_exchange_id: "turn-followup",
            working_turn_id: "turn-followup",
            attachments: [{ id: "file_shared" }],
          },
        },
      }),
    ]);
    const all = [upload, first, followup];

    expect(resolveChatgptTurnGroup(first, all)?.records.map((item) => item.requestId)).toEqual([
      "upload",
      "chat-first",
    ]);
    expect(resolveChatgptTurnGroup(followup, all)?.records.map((item) => item.requestId)).toEqual([
      "chat-followup",
    ]);
    expect(chatgptMotherTurnKey(upload, all)).toBe(chatgptMotherTurnKey(first, all));
  });

  it("prefers origination_message_id over repeated file references", () => {
    const upload = record("upload-origin", 1, [event({ type: "file.processing.completed" })], {
      url: "https://chatgpt.com/backend-api/files/process_upload_stream",
      transport: "fetch",
      requestPayloadPreview: JSON.stringify({
        file_id: "file_shared",
        library_file_info: { origination_message_id: "msg-target" },
      }),
    });
    const earlier = record("chat-earlier", 2, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: {
          id: "msg-earlier",
          metadata: {
            turn_exchange_id: "turn-earlier",
            working_turn_id: "turn-earlier",
            attachments: [{ id: "file_shared" }],
          },
        },
      }),
    ]);
    const target = record("chat-target", 3, [
      event({
        type: "input_message",
        conversation_id: "conv",
        input_message: {
          id: "msg-target",
          metadata: {
            turn_exchange_id: "turn-target",
            working_turn_id: "turn-target",
            attachments: [{ id: "file_shared" }],
          },
        },
      }),
    ]);
    const all = [upload, earlier, target];

    expect(resolveChatgptTurnGroup(earlier, all)?.records.map((item) => item.requestId)).toEqual([
      "chat-earlier",
    ]);
    expect(resolveChatgptTurnGroup(target, all)?.records.map((item) => item.requestId)).toEqual([
      "upload-origin",
      "chat-target",
    ]);
    expect(chatgptMotherTurnKey(upload, all)).toBe(chatgptMotherTurnKey(target, all));
  });

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
