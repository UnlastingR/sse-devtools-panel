import { describe, it, expect } from "vitest";
import { ConversationMergeSession, mergeAiConversation } from "../index";

function assert(cond: unknown, msg: string): asserts cond {
  expect(cond, msg).toBeTruthy();
}

describe("session", () => {
  it("matches previous script coverage", () => {
    function chunk(content) {
      return {
        event: "message",
        data: JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content } }],
        }),
      };
    }

    const events = [chunk("Hel"), chunk("lo"), chunk("!")];
    const oneShot = mergeAiConversation(events);

    const session = new ConversationMergeSession();
    session.push(events.slice(0, 1));
    session.push(events.slice(0, 2));
    session.push(events);
    const incremental = session.snapshot();

    assert(
      oneShot.channels.content === "Hello!",
      `oneShot content got ${oneShot.channels.content}`,
    );
    assert(
      incremental.channels.content === oneShot.channels.content,
      "incremental matches one-shot content",
    );
    assert(incremental.profile === oneShot.profile, "profile match");
    assert(session.consumedCount === 3, "consumed all");

    // Further push with no new events is a no-op
    session.push(events);
    assert(session.snapshot().channels.content === "Hello!", "idempotent");
  });

  it("rebuilds when an earlier event is inserted before the consumed prefix", () => {
    function chunk(content) {
      return {
        event: "message",
        data: JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content } }],
        }),
      };
    }

    const a = chunk("A");
    const b = chunk("B");
    const inserted = chunk("X");
    const session = new ConversationMergeSession();
    session.push([a, b]);
    expect(session.snapshot().channels.content).toBe("AB");

    session.push([a, inserted, b]);
    expect(session.snapshot().channels.content).toBe("AXB");
  });
});
