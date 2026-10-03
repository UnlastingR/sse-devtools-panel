import { describe, expect, it } from "vitest";
import { ConversationScrollMemory } from "../conversation-scroll-memory";

describe("ConversationScrollMemory", () => {
  it("keeps Content, Reasoning, Tools and Meta positions independent", () => {
    const memory = new ConversationScrollMemory();
    memory.remember("stream-a", "content", 100);
    memory.remember("stream-a", "reasoning", 200);
    memory.remember("stream-a", "tools", 300);
    memory.remember("stream-a", "meta", 400);

    expect(memory.restore("stream-a", "content", 1000, 100)).toBe(100);
    expect(memory.restore("stream-a", "reasoning", 1000, 100)).toBe(200);
    expect(memory.restore("stream-a", "tools", 1000, 100)).toBe(300);
    expect(memory.restore("stream-a", "meta", 1000, 100)).toBe(400);
  });

  it("does not leak a channel position between streams", () => {
    const memory = new ConversationScrollMemory();
    memory.remember("stream-a", "reasoning", 240);
    memory.remember("stream-b", "reasoning", 640);

    expect(memory.restore("stream-a", "reasoning", 1000, 100)).toBe(240);
    expect(memory.restore("stream-b", "reasoning", 1000, 100)).toBe(640);
  });

  it("clamps a remembered position when the pane becomes shorter", () => {
    const memory = new ConversationScrollMemory();
    memory.remember("stream-a", "tools", 900);

    expect(memory.restore("stream-a", "tools", 500, 120)).toBe(380);
    expect(memory.restore("stream-a", "tools", 80, 120)).toBe(0);
  });

  it("clears all remembered positions", () => {
    const memory = new ConversationScrollMemory();
    memory.remember("stream-a", "content", 100);
    memory.remember("stream-b", "tools", 200);
    memory.clear();

    expect(memory.restore("stream-a", "content", 1000, 100)).toBeUndefined();
    expect(memory.restore("stream-b", "tools", 1000, 100)).toBeUndefined();
  });

  it("normalizes negative positions and ignores non-finite values", () => {
    const memory = new ConversationScrollMemory();
    memory.remember("stream-a", "content", -10);
    memory.remember("stream-b", "content", Number.NaN);

    expect(memory.restore("stream-a", "content", 1000, 100)).toBe(0);
    expect(memory.restore("stream-b", "content", 1000, 100)).toBeUndefined();
  });
});
