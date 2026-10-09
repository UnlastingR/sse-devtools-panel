import { describe, it, expect, vi } from "vitest";
import { eventTypeFromOnProperty, patchEventSource, toSseFrame } from "../patch-eventsource";

function assert(cond: unknown, msg: string): asserts cond {
  expect(cond, msg).toBeTruthy();
}

describe("patch-eventsource", () => {
  it("matches previous script coverage", () => {
    assert(eventTypeFromOnProperty("onping") === "ping", "onping");
    assert(eventTypeFromOnProperty("onmessage") === "message", "onmessage");
    assert(eventTypeFromOnProperty("on") === null, "too short");
    assert(eventTypeFromOnProperty("message") === null, "not on*");
    assert(toSseFrame("ping", "hi").includes("event: ping\n"), "frame event");
    assert(toSseFrame("message", "hi").startsWith("data:"), "default message");
  });

  it("preserves native brand-checked getters, setters, and EventTarget methods", () => {
    class NativeLikeEventSource extends EventTarget {
      static readonly CLOSED = 2;
      #url: string;
      #readyState = 1;
      #onmessage: EventListener | null = null;

      constructor(url: string) {
        super();
        this.#url = url;
      }

      get url(): string {
        return this.#url;
      }

      get readyState(): number {
        return this.#readyState;
      }

      get onmessage(): EventListener | null {
        return this.#onmessage;
      }

      set onmessage(listener: EventListener | null) {
        this.#onmessage = listener;
      }

      override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
        void this.#url; // emulate the native receiver brand check
        super.removeEventListener(...args);
      }

      override dispatchEvent(event: Event): boolean {
        void this.#readyState;
        return super.dispatchEvent(event);
      }

      close(): void {
        this.#readyState = NativeLikeEventSource.CLOSED;
      }
    }

    vi.stubGlobal("window", { EventSource: NativeLikeEventSource });
    const chunks: string[] = [];
    const restore = patchEventSource(
      () => "test-es",
      () => {},
      ({ text }) => chunks.push(text),
      () => {},
      () => {},
      () => {},
    );
    try {
      const source = new window.EventSource("https://example.test/sse?access_token=secret");
      expect(source.url).toBe("https://example.test/sse?access_token=secret");
      expect(source.readyState).toBe(1);
      const handler = vi.fn();
      source.onmessage = handler;
      expect(source.onmessage).toBe(handler);
      const listener = vi.fn();
      source.addEventListener("ping", listener);
      expect(source.removeEventListener).toBe(source.removeEventListener);
      source.removeEventListener("ping", listener);
      expect(source.dispatchEvent(new Event("ping"))).toBe(true);
      expect(chunks).toEqual(["event: ping\ndata: \n\n"]);
      expect(listener).not.toHaveBeenCalled();
      source.close();
      expect(source.readyState).toBe(NativeLikeEventSource.CLOSED);
    } finally {
      restore();
      vi.unstubAllGlobals();
    }
  });
});
