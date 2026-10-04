import { t } from "../../shared/i18n";
import { saveStreamArchive } from "../../shared/stream-archive-db";
import {
  buildSseFixture,
  buildStreamExportCsv,
  buildStreamsExportCsv,
  buildStreamExportPayload,
  createRequestId,
  parseStreamExportJson,
  streamRecordFromExport,
} from "../../shared/stream-snapshot";
import { resolveChatgptTurnGroups } from "../../shared/chatgpt-logical-turn";
import type { SseEvent, StreamRecord } from "../../shared/types";
import { buildExportFilename, shortPath } from "../core/format";
import { state } from "../core/state";
import { downloadTextFile, showToast } from "../core/ui-chrome";

export type ExportImportHooks = {
  getBrowsableEvents: (record: StreamRecord) => SseEvent[];
  renderList: () => void;
  renderDetail: (appendFriendly?: boolean) => void;
};

function selectedExportRecords(): StreamRecord[] {
  const all = Array.from(state.streams.values());
  const groups = resolveChatgptTurnGroups(all);
  const groupByKey = new Map(groups.map((group) => [group.key, group] as const));
  const selected = new Map<string, StreamRecord>();
  const keys =
    state.selectedSidebarKeys.size > 0
      ? Array.from(state.selectedSidebarKeys)
      : state.selectedId
        ? [`stream:${state.selectedId}`]
        : [];

  for (const key of keys) {
    if (key.startsWith("stream:")) {
      const id = key.slice("stream:".length);
      const record = state.streams.get(id);
      if (record) selected.set(record.requestId, record);
      continue;
    }
    if (key.startsWith("turn:")) {
      const group = groupByKey.get(key.slice("turn:".length));
      if (!group) continue;
      for (const record of group.records) selected.set(record.requestId, record);
    }
  }

  return Array.from(selected.values()).sort(
    (a, b) => a.startedAt - b.startedAt || a.requestId.localeCompare(b.requestId),
  );
}

function selectionFilename(
  records: ReadonlyArray<StreamRecord>,
  ext: "json" | "csv" | "sse" | "txt",
): string {
  if (records.length === 1) {
    if (ext !== "txt") return buildExportFilename(records[0]!, ext);
    return buildExportFilename(records[0]!, "json").replace(/\.json$/, ".txt");
  }
  const stamp = new Date(records[0]?.startedAt ?? Date.now()).toISOString().replace(/[:.]/g, "-");
  return `eventstream-selection-${records.length}-${stamp}.${ext}`;
}

function rawBundle(records: ReadonlyArray<StreamRecord>): string {
  const sections = records.map((record, index) => {
    const lines: string[] = [
      `===== stream ${index + 1}/${records.length} =====`,
      `requestId: ${record.requestId}`,
      `url: ${record.url}`,
      `method: ${record.method}`,
      `transport: ${record.transport}`,
      `streamKind: ${record.streamKind}`,
      `status: ${record.status ?? ""}`,
      `streamStatus: ${record.streamStatus}`,
      `startedAt: ${new Date(record.startedAt).toISOString()}`,
      `endedAt: ${record.endedAt ? new Date(record.endedAt).toISOString() : ""}`,
    ];
    if (record.requestHeaders) {
      lines.push("----- request headers -----", JSON.stringify(record.requestHeaders, null, 2));
    }
    if (record.requestPayloadPreview) {
      lines.push(
        `----- request payload${record.requestPayloadTruncated ? " (truncated)" : ""} -----`,
        record.requestPayloadPreview,
      );
    }
    if (record.responseHeaders) {
      lines.push("----- response headers -----", JSON.stringify(record.responseHeaders, null, 2));
    }
    lines.push("----- raw begin -----", record.raw, "----- raw end -----");
    return lines.join("\n");
  });
  return `${sections.join("\n\n")}\n`;
}

function fixtureBundle(records: ReadonlyArray<StreamRecord>): string {
  return records
    .map((record, index) => {
      const header = [
        `: stream ${index + 1}/${records.length}`,
        `: requestId ${record.requestId}`,
        `: ${record.transport} ${record.method} ${record.url}`,
      ].join("\n");
      return `${header}\n\n${buildSseFixture(record.events).trimEnd()}\n`;
    })
    .join("\n");
}

/** Export selected stream for sharing / repro. */
export function exportSelectedStreamJson(): void {
  const records = selectedExportRecords();
  if (records.length === 0) {
    window.alert(t("needSelectedStream"));
    return;
  }
  const payload =
    records.length === 1
      ? buildStreamExportPayload(records[0]!)
      : {
          format: "eventstream-stream-bundle-v1",
          exportedAt: Date.now(),
          streams: records.map((record) => buildStreamExportPayload(record).stream),
        };
  downloadTextFile(
    selectionFilename(records, "json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "application/json;charset=utf-8",
  );
  showToast(t("toastExportedJson"));
}

/** CSV export; respects current Events search filter. */
export function exportSelectedStreamCsv(hooks: ExportImportHooks): void {
  const records = selectedExportRecords();
  if (records.length === 0) {
    window.alert(t("needSelectedStream"));
    return;
  }
  const items = records
    .map((record) => ({ record, events: hooks.getBrowsableEvents(record) }))
    .filter((item) => item.events.length > 0);
  const total = items.reduce((sum, item) => sum + item.events.length, 0);
  if (total === 0) {
    window.alert(t("exportCsvEmpty"));
    return;
  }
  downloadTextFile(
    selectionFilename(records, "csv"),
    records.length === 1
      ? buildStreamExportCsv(items[0]!.record, items[0]!.events)
      : buildStreamsExportCsv(items),
    "text/csv;charset=utf-8",
  );
  showToast(t("toastExportedCsv", String(total)));
}

/** Rebuild text/event-stream fixture from parsed events. */
export function exportSelectedStreamFixture(): void {
  const records = selectedExportRecords();
  if (records.length === 0) {
    window.alert(t("needSelectedStream"));
    return;
  }
  const nonEmpty = records.filter((record) => record.events.length > 0);
  if (nonEmpty.length === 0) {
    window.alert(t("exportFixtureEmpty"));
    return;
  }
  downloadTextFile(
    selectionFilename(records, "sse"),
    nonEmpty.length === 1 ? buildSseFixture(nonEmpty[0]!.events) : fixtureBundle(nonEmpty),
    "text/event-stream;charset=utf-8",
  );
  showToast(t("toastExportedFixture"));
}

export function exportSelectedRawStreams(): void {
  const records = selectedExportRecords();
  if (records.length === 0) {
    window.alert(t("needSelectedStream"));
    return;
  }
  downloadTextFile(
    selectionFilename(records, "txt"),
    rawBundle(records),
    "text/plain;charset=utf-8",
  );
  showToast(t("toastExportedRaw", String(records.length)));
}

export function addStaticStream(record: StreamRecord, hooks: ExportImportHooks): void {
  state.streams.set(record.requestId, record);
  state.parsers.delete(record.requestId);
  state.selectedId = record.requestId;
  state.selectedSidebarKeys.clear();
  state.selectedSidebarKeys.add(`stream:${record.requestId}`);
  state.selectionAnchorKey = `stream:${record.requestId}`;
  state.selectedEventIndex = null;
  hooks.renderList();
  hooks.renderDetail();
}

export async function importStreamFromFile(file: File, hooks: ExportImportHooks): Promise<void> {
  const text = await file.text();
  const body = parseStreamExportJson(text);
  const record = streamRecordFromExport(body, {
    requestId: createRequestId("imp"),
    origin: "imported",
  });
  addStaticStream(record, hooks);
}

export async function saveSelectedStreamArchive(): Promise<void> {
  const record = state.selectedId ? state.streams.get(state.selectedId) : undefined;
  if (!record) {
    window.alert(t("needSelectedStream"));
    return;
  }
  const defaultName = `${shortPath(record.url)} @ ${new Date(record.startedAt).toLocaleString()}`;
  const name = window.prompt(t("archiveNamePrompt"), defaultName);
  if (name == null) return;
  if (!name.trim()) {
    window.alert(t("archiveNameRequired"));
    return;
  }
  await saveStreamArchive(name, record);
  showToast(t("toastArchiveSaved"));
}
