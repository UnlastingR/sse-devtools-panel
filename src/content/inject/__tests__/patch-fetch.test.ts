import { describe, expect, it, vi } from "vitest";
import { bypassChatGptJsonApi, patchFetch } from "../patch-fetch";

describe("patch-fetch", () => {
  it("bypasses ordinary ChatGPT JSON APIs but preserves streaming hints", () => {
    vi.stubGlobal("window", { location: { href: "https://chatgpt.com/" } });
    try {
      for (const url of [
        "/backend-api/me",
        "/backend-api/tpp/models/?iim=false",
        "/backend-api/conversation/init",
        "/backend-api/settings/is_adult",
      ]) {
        expect(bypassChatGptJsonApi(url)).toBe(true);
      }
      expect(bypassChatGptJsonApi("/backend-api/f/conversation")).toBe(false);
      expect(bypassChatGptJsonApi("/backend-api/f/conversation/resume")).toBe(false);
      expect(bypassChatGptJsonApi("/backend-api/conversation")).toBe(false);
      expect(
        bypassChatGptJsonApi("/backend-api/other", {
          headers: { Accept: "text/event-stream" },
        }),
      ).toBe(false);
      expect(bypassChatGptJsonApi("/backend-api/other?stream=true")).toBe(false);
      expect(
        bypassChatGptJsonApi("/backend-api/other", {
          body: '{"stream":true}',
        }),
      ).toBe(false);
      expect(bypassChatGptJsonApi("https://example.test/backend-api/me")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns the original native Promise for nonstream ChatGPT API calls", async () => {
    const response = new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
    const promise = Promise.resolve(response);
    const nativeFetch = vi.fn(() => promise);
    vi.stubGlobal("window", {
      fetch: nativeFetch,
      location: { href: "https://chatgpt.com/" },
    });
    const postStart = vi.fn();
    const restore = patchFetch(
      () => "unused",
      postStart,
      () => {},
      () => {},
      () => {},
      () => {},
    );
    try {
      const received = window.fetch("https://chatgpt.com/backend-api/me");
      expect(received).toBe(promise);
      expect(await received).toBe(response);
      expect(postStart).not.toHaveBeenCalled();
      expect(nativeFetch).toHaveBeenCalledOnce();
    } finally {
      restore();
      vi.unstubAllGlobals();
    }
  });

  it("makes a hidden stale fetch wrapper a transparent pass-through after cleanup", async () => {
    const response = new Response("ok");
    const promise = Promise.resolve(response);
    const nativeFetch = vi.fn(() => promise);
    vi.stubGlobal("window", {
      fetch: nativeFetch,
      location: { href: "https://example.test/" },
    });
    const postStart = vi.fn();
    const restore = patchFetch(
      () => "unused",
      postStart,
      () => {},
      () => {},
      () => {},
      () => {},
    );
    const staleFetch = window.fetch;
    // Another script takes over window.fetch and delegates to our old proxy.
    window.fetch = (...args) => staleFetch(...args);
    restore();
    try {
      const received = window.fetch("https://example.test/stream", {
        headers: { Accept: "text/event-stream" },
      });
      expect(received).toBe(promise);
      expect(await received).toBe(response);
      expect(postStart).not.toHaveBeenCalled();
      expect(nativeFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves a 403 JSON response and records an HTTP error instead of success", async () => {
    const nativeFetch = vi.fn(
      async () =>
        new Response('{"detail":"Forbidden"}', {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("window", { fetch: nativeFetch, location: { href: "https://example.test/" } });
    const starts: Array<{ url: string; status?: number }> = [];
    const ends: string[] = [];
    const errors: Array<{ closeReason: string; message: string }> = [];
    const restore = patchFetch(
      () => "fetch-1",
      (event) => starts.push({ url: event.url, status: event.status }),
      () => {},
      (event) => ends.push(event.closeReason),
      (event) => errors.push({ closeReason: event.closeReason, message: event.message }),
      () => {},
    );
    try {
      const response = await window.fetch("https://example.test/sse?api_key=secret", {
        headers: { Accept: "text/event-stream" },
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('{"detail":"Forbidden"}');
      expect(nativeFetch).toHaveBeenCalledOnce();
      expect(starts.some((s) => s.status === 403)).toBe(true);
      expect(starts.every((s) => !s.url.includes("secret"))).toBe(true);
      expect(errors).toEqual([{ closeReason: "http_error", message: "HTTP 403" }]);
      expect(ends).toEqual([]);
    } finally {
      restore();
      vi.unstubAllGlobals();
    }
  });

  it("does not reject a successful fetch if the recorder throws", async () => {
    const response = new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    vi.stubGlobal("window", {
      fetch: vi.fn(async () => response),
      location: { href: "https://chatgpt.com/" },
    });
    const restore = patchFetch(
      () => "fetch-2",
      () => {
        throw new Error("recorder offline");
      },
      () => {},
      () => {},
      () => {},
      () => {},
    );
    try {
      const received = await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
        headers: { Accept: "text/event-stream" },
      });
      expect(received).toBe(response);
      expect(await received.text()).toBe("data: ok\n\n");
    } finally {
      restore();
      vi.unstubAllGlobals();
    }
  });
});
