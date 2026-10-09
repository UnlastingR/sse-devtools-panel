import { describe, expect, it } from "vitest";
import { captureFetchResponseBody } from "../stream";

describe("passive stream capture", () => {
  it("does not disturb page reads when a capture callback throws", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
    );
    const errors: string[] = [];
    const returned = captureFetchResponseBody(
      response,
      {
        onBytes: () => {
          throw new Error("extension context invalidated");
        },
        onComplete: () => {},
        onError: (message) => errors.push(message),
      },
      "observe",
    );
    expect(returned).toBe(response);
    const reader = returned.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("hello");
    expect((await reader.read()).done).toBe(true);
    expect(errors).toEqual([]);
  });

  it("returns the original response when a native stream is non-extensible", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ok"));
        controller.close();
      },
    });
    Object.preventExtensions(stream);
    const response = new Response(stream);
    const errors: string[] = [];
    const returned = captureFetchResponseBody(
      response,
      {
        onBytes: () => {},
        onComplete: () => {},
        onError: (message) => errors.push(message),
      },
      "observe",
    );
    expect(returned).toBe(response);
    expect(await returned.text()).toBe("ok");
    expect(errors).toEqual(["Unable to attach passive stream capture"]);
  });
});
