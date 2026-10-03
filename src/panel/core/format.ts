import { t } from "../../shared/i18n";
import type { HistogramBin } from "../../shared/stream-timing";
import type { StreamCloseReason, StreamRecord, StreamTransport } from "../../shared/types";

export const DATA_PREVIEW_LEN = 80;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function shortPath(url: string): string {
  try {
    const u = new URL(url, "https://example.com");
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Compact wall clock for dense sidebar rows (no milliseconds). */
export function formatTimeShort(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function previewData(data: string): string {
  const oneLine = data.replace(/\s+/g, " ").trim();
  if (oneLine.length <= DATA_PREVIEW_LEN) return oneLine;
  return oneLine.slice(0, DATA_PREVIEW_LEN) + "…";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

export function formatMetricMs(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)} ms`;
}

/** Approximate size label for long string fields (char-count based). */
export function formatApproxSize(charCount: number): string {
  if (!Number.isFinite(charCount) || charCount < 0) return "0 B";
  if (charCount < 1024) return `${Math.round(charCount)} B`;
  if (charCount < 1024 * 1024) return `${(charCount / 1024).toFixed(1)} KB`;
  return `${(charCount / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatGapBinLabel(bin: HistogramBin): string {
  if (!Number.isFinite(bin.toMs)) {
    if (bin.fromMs >= 60_000) return `≥${bin.fromMs / 60_000}m`;
    if (bin.fromMs >= 1000) return `≥${bin.fromMs / 1000}s`;
    return `≥${bin.fromMs}ms`;
  }
  const compact = (ms: number): string => {
    if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
    if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
    return `${ms}ms`;
  };
  const from = compact(bin.fromMs);
  const to = compact(bin.toMs);
  const unitOf = (label: string): "ms" | "s" | "m" => {
    if (label.endsWith("ms")) return "ms";
    if (label.endsWith("s")) return "s";
    return "m";
  };
  const unit = unitOf(from);
  if (unit === unitOf(to)) {
    const trim = unit === "ms" ? 2 : 1;
    return `${from.slice(0, -trim)}–${to}`;
  }
  return `${from}–${to}`;
}

export function sanitizeFilenamePart(value: string): string {
  // Strip Windows-forbidden and control characters from export filenames.
  // eslint-disable-next-line no-control-regex -- intentional control-char scrubbing
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "stream";
}

export function buildExportFilename(record: StreamRecord, ext: "json" | "csv" | "sse"): string {
  const path = shortPath(record.url).replace(/^\//, "") || "stream";
  const stamp = new Date(record.startedAt).toISOString().replace(/[:.]/g, "-");
  return `sse-stream-${sanitizeFilenamePart(path)}-${stamp}.${ext}`;
}

export function originLabel(origin: StreamRecord["origin"]): string | null {
  if (origin === "imported") return t("originImported");
  if (origin === "archive") return t("originArchive");
  return null;
}

export function statusLabel(status: StreamRecord["streamStatus"]): string {
  switch (status) {
    case "streaming":
      return t("statusStreaming");
    case "done":
      return t("statusDone");
    case "error":
      return t("statusError");
    default:
      return status;
  }
}

export function closeReasonLabel(reason: StreamCloseReason): string {
  switch (reason) {
    case "complete":
      return t("closeReasonComplete");
    case "abort":
      return t("closeReasonAbort");
    case "error":
      return t("closeReasonError");
    case "http_error":
      return t("closeReasonHttpError");
    default:
      return reason;
  }
}

export function transportLabel(transport: StreamTransport): string {
  switch (transport) {
    case "fetch":
      return t("transportFetch");
    case "eventsource":
      return t("transportEventSource");
    case "xhr":
      return t("transportXhr");
    default:
      return transport;
  }
}

export function streamStatusShort(status: StreamRecord["streamStatus"]): string {
  switch (status) {
    case "streaming":
      return t("statusLive");
    case "done":
      return t("statusDoneShort");
    case "error":
      return t("statusErrorShort");
    default:
      return statusLabel(status);
  }
}
