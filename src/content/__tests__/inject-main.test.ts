import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({
  installCalls: 0,
  uninstallCalls: 0,
}));

vi.mock("../inject/patch-fetch", () => ({
  patchFetch: () => {
    capture.installCalls += 1;
    const previous = window.fetch;
    const hooked = (...args: Parameters<typeof window.fetch>) => previous(...args);
    window.fetch = hooked;
    return () => {
      capture.uninstallCalls += 1;
      if (window.fetch === hooked) window.fetch = previous;
    };
  },
}));
vi.mock("../inject/patch-eventsource", () => ({ patchEventSource: () => () => {} }));
vi.mock("../inject/patch-xhr", () => ({ patchXhr: () => () => {} }));
vi.mock("../inject/patch-websocket", () => ({ patchWebSocket: () => () => {} }));

describe("page injection hook lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    capture.installCalls = 0;
    capture.uninstallCalls = 0;
  });

  it("does not reinstall hooks when a foreign fetch wrapper appears during heartbeats", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const nativeFetch = vi.fn(async () => new Response("ok"));
    const page = {
      fetch: nativeFetch as typeof window.fetch,
      addEventListener: (_type: string, handler: (event: unknown) => void) =>
        listeners.push(handler),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("window", page);
    await import("../inject-main");
    const toggle = (enabled: boolean) => {
      for (const handler of listeners) {
        handler({
          source: window,
          data: {
            source: "eventstream-control",
            type: "capture-control",
            payload: { enabled },
          },
        });
      }
    };

    toggle(true);
    expect(capture.installCalls).toBe(1);
    const firstHook = page.fetch;
    page.fetch = ((...args: Parameters<typeof window.fetch>) =>
      firstHook(...args)) as typeof window.fetch;
    const foreignHook = page.fetch;

    for (let i = 0; i < 5; i += 1) toggle(true);
    expect(page.fetch).toBe(foreignHook);
    expect(capture.installCalls).toBe(1);
    expect(capture.uninstallCalls).toBe(0);

    toggle(false);
    expect(capture.uninstallCalls).toBe(1);
    expect(page.fetch).toBe(foreignHook);
  });
});
