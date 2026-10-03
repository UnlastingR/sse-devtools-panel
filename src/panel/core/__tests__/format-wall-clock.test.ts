import { describe, it, expect, vi, afterEach } from "vitest";
import { formatGapBinLabel, formatTimeShort } from "../format";

describe("formatTimeShort", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats local HH:mm:ss without milliseconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T06:32:01.435Z"));
    const ts = Date.now();
    expect(formatTimeShort(ts)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatTimeShort(ts)).not.toContain(".");
  });
});

describe("formatGapBinLabel", () => {
  it("uses compact mixed units for long histogram ranges", () => {
    expect(formatGapBinLabel({ fromMs: 500, toMs: 1000, label: "", count: 0 })).toBe("500ms–1s");
    expect(formatGapBinLabel({ fromMs: 1000, toMs: 10_000, label: "", count: 0 })).toBe("1–10s");
    expect(formatGapBinLabel({ fromMs: 30_000, toMs: 60_000, label: "", count: 0 })).toBe("30s–1m");
    expect(formatGapBinLabel({ fromMs: 60_000, toMs: 180_000, label: "", count: 0 })).toBe("1–3m");
    expect(
      formatGapBinLabel({ fromMs: 180_000, toMs: Number.POSITIVE_INFINITY, label: "", count: 0 }),
    ).toBe("≥3m");
  });
});
