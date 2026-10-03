import { describe, expect, it } from "vitest";
import {
  extractChatgptWebSocketTurnItems,
  redactChatgptWebSocketEncodedItem,
} from "../patch-websocket";

function streamItem(topicId: string, id: string, encodedItem: string) {
  return {
    type: "message",
    topic_id: topicId,
    payload: {
      type: "conversation-turn-stream",
      payload: {
        type: "stream-item",
        stream_item_id: id,
        encoded_item: encodedItem,
      },
    },
  };
}

describe("patch-websocket", () => {
  it("redacts resume topic tokens before capture/export", () => {
    const frame =
      'data: {"type":"resume_conversation_token","kind":"topic","token":"secret-jwt","conversation_id":"conv"}\n\n';
    expect(redactChatgptWebSocketEncodedItem(frame)).toBe(
      'data: {"type":"resume_conversation_token","kind":"topic","token":"[REDACTED]","conversation_id":"conv"}\n\n',
    );
  });

  it("extracts live ChatGPT Work turn items", () => {
    const topic = "conversation-turn-test";
    expect(
      extractChatgptWebSocketTurnItems([
        streamItem(topic, "item-1", 'event: delta_encoding\ndata: "v1"\n\n'),
        streamItem(topic, "item-2", "data: [DONE]\n\n"),
        {
          type: "message",
          topic_id: topic,
          payload: { type: "conversation-turn-stream", payload: { type: "done" } },
        },
      ]),
    ).toEqual([
      {
        topicId: topic,
        type: "chunk",
        streamItemId: "item-1",
        encodedItem: 'event: delta_encoding\ndata: "v1"\n\n',
      },
      {
        topicId: topic,
        type: "chunk",
        streamItemId: "item-2",
        encodedItem: "data: [DONE]\n\n",
      },
      { topicId: topic, type: "done" },
    ]);
  });

  it("extracts messages embedded in subscribe catchups", () => {
    const topic = "conversation-turn-catchup";
    const frame = [
      {
        id: 4,
        type: "reply",
        reply: {
          type: "subscribe",
          topic_id: topic,
          recovered: true,
          catchups: [streamItem(topic, "catchup-1", 'data: {"type":"stream_handoff"}\n\n')],
        },
      },
    ];

    expect(extractChatgptWebSocketTurnItems(frame)).toEqual([
      {
        topicId: topic,
        type: "chunk",
        streamItemId: "catchup-1",
        encodedItem: 'data: {"type":"stream_handoff"}\n\n',
      },
    ]);
  });

  it("ignores unrelated WebSocket topics", () => {
    expect(
      extractChatgptWebSocketTurnItems([
        streamItem("conversations", "item-1", "data: {}\n\n"),
        { type: "reply", reply: { type: "presence" } },
      ]),
    ).toEqual([]);
  });
});
