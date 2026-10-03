import { describe, expect, it } from "vitest";
import type { StreamRecord } from "../../../shared/types";
import { scanStreamAnomalies } from "../stream-anomalies";

function record(url: string, data: string): StreamRecord {
  return {
    requestId: `${url}:${data.length}`,
    url,
    method: "POST",
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    transport: "fetch",
    streamKind: "sse",
    startedAt: 0,
    streamStatus: "done",
    raw: `data: ${data}\n\n`,
    events: [
      {
        event: "message",
        data,
        raw: `data: ${data}`,
        index: 0,
        receivedAt: 0,
      },
    ],
  };
}

describe("stream anomalies", () => {
  it("uses a higher oversized-packet threshold for ChatGPT conversation streams", () => {
    const medium = JSON.stringify({ payload: "x".repeat(80_000) });
    const chatgpt = record("https://chatgpt.com/backend-api/f/conversation", medium);
    const upload = record("https://chatgpt.com/backend-api/files/process_upload_stream", medium);

    expect(scanStreamAnomalies(chatgpt).some((a) => a.kind === "oversized-packet")).toBe(false);
    expect(scanStreamAnomalies(upload).some((a) => a.kind === "oversized-packet")).toBe(true);
  });

  it("still flags very large ChatGPT conversation events", () => {
    const huge = JSON.stringify({ payload: "x".repeat(130_000) });
    const chatgpt = record("https://chatgpt.com/backend-api/f/conversation", huge);
    expect(scanStreamAnomalies(chatgpt).some((a) => a.kind === "oversized-packet")).toBe(true);
  });

  it("does not treat the SSE [DONE] sentinel as malformed JSON", () => {
    const chatgpt = record("https://chatgpt.com/backend-api/f/conversation", "[DONE]");
    expect(scanStreamAnomalies(chatgpt).some((a) => a.kind === "json-parse-failed")).toBe(false);
  });
});
