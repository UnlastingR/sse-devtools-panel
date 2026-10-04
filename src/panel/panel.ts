import "driver.js/dist/driver.css";
import "./panel.css";
import { applyIcons, renderIcon, type IconName } from "./core/icons";
import {
  PANEL_PORT,
  type RelayMessage,
  type SseEvent,
  type StreamChunkPayload,
  type StreamEndPayload,
  type StreamErrorPayload,
  type StreamKind,
  type StreamRecord,
  type StreamReconnectPayload,
  type StreamStartPayload,
} from "../shared/types";
import {
  applyDomI18n,
  getActiveLocale,
  initI18n,
  onLocaleChange,
  t,
  uiLanguage,
} from "../shared/i18n";
import {
  getActiveThemePreference,
  initTheme,
  onThemeChange,
  setThemePreference,
  type ThemePreference,
} from "../shared/theme";
import { stampReceivedAt } from "../shared/event-stamp";
import { latestEventIdFromEvents, streamHasExplicitCompletion } from "../shared/stream-close";
import { chatgptMotherTurnKey, resolveChatgptTurnGroups } from "../shared/chatgpt-logical-turn";
import { SseParser, type ParsedSseEvent } from "../shared/sse-parser";
import { NdjsonParser } from "../shared/ndjson-parser";
import { ConnectJsonParser } from "../shared/connect-json-parser";
import {
  clearConversationMergeSessions,
  conversationHasContent,
  discardConversationMergeSession,
  getConversationMergeSession,
  mergeChatgptTurnGroup,
  syncConversationMergeSession,
} from "../shared/ai-merge";
import { initEventsColumnResizers } from "./widgets/column-resizer";
import {
  elList,
  elMeta,
  elMetaMethod,
  elMetaUrl,
  elMetaTags,
  elStreamsUrlFilter,
  elStreamsTransportFilter,
  elExportJson,
  elExportCsv,
  elExportFixture,
  elExportRaw,
  elImportJson,
  elPauseUi,
  elImportFile,
  elSaveArchive,
  elArchives,
  elStats,
  elAnomalies,
  elSpecWarnings,
  elSearchAll,
  elDialog,
  elDialogClose,
  elStatusbarCapture,
  elStatusbarLocale,
  elTabCountEvents,
  elTabCountRaw,
  elTabCountConversation,
  elExportMenu,
  elExportMenuBtn,
  elExportMenuPanel,
  elMoreMenu,
  elMoreMenuBtn,
  elMoreMenuPanel,
  elThemeMenu,
  elThemeMenuBtn,
  elThemeMenuPanel,
  elThemeSystem,
  elThemeLight,
  elThemeNight,
  elDrawer,
  elDrawerClose,
  elDrawerPrev,
  elDrawerNext,
  elDrawerCopy,
  elContextMenu,
  elEventsSearch,
  elDrawerSearch,
  elTableWrap,
  elSidebarResizer,
  elResizer,
  elEvents,
} from "./core/dom";
import { escapeHtml, formatDuration, formatTime, closeReasonLabel } from "./core/format";
import { computeStreamMetrics } from "./features/stream-metrics";
import {
  clearStreamAnomalyCaches,
  invalidateStreamAnomalyCache,
} from "./features/stream-anomalies";
import { renderTimeline } from "./views/timeline-view";
import { renderRequest, resetRequestViewState } from "./views/request-view-ui";
import { renderConversation, resetConversationView } from "./views/conversation-view";
import { renderRawView, resetRawView } from "./views/raw-view";
import { state, type ActiveTab, type StreamParser } from "./core/state";
import {
  closeAllMenus,
  closeAppDialog,
  copyText,
  openMoreMenu,
  refreshStatusbarSummary,
  setUiPaused,
  showToast,
  toggleMenu,
} from "./core/ui-chrome";
import {
  addStaticStream,
  exportSelectedStreamCsv,
  exportSelectedStreamFixture,
  exportSelectedStreamJson,
  exportSelectedRawStreams,
  importStreamFromFile,
  saveSelectedStreamArchive,
  type ExportImportHooks,
} from "./features/export-import";
import {
  maybeStartOnboardingTour,
  refreshTourI18n,
  startOnboardingTour,
  type OnboardingTourHooks,
} from "./features/onboarding-tour";
import { buildTourSampleRecord } from "./features/tour-sample";
import {
  showAnomaliesDialog,
  showArchivesDialog,
  showGlobalSearchDialog,
  showSpecWarningsDialog,
  showStatsDialog,
  type DialogHooks,
} from "./features/dialogs";
import {
  applyDrawerWidth,
  applyDrawerSearch,
  applyEventsFilter,
  clearEventsView,
  closeDrawer,
  DRAWER_WIDTH_MAX,
  DRAWER_WIDTH_MIN,
  getBrowsableEvents,
  hideContextMenu,
  navigateDrawer,
  renderEvents,
  selectEventByIndex,
  showContextMenu,
  updateDrawerNavButtons,
  bindJsonTreeContextMenu,
} from "./views/events-view";
import { renderList, scheduleRenderList } from "./views/stream-list";

const pauseHooks = {
  renderList,
  renderDetail,
};

const exportHooks: ExportImportHooks = {
  getBrowsableEvents,
  renderList,
  renderDetail,
};

const dialogHooks: DialogHooks = {
  renderList,
  renderDetail,
  activateTab: (tab) => activateTab(tab),
  selectEventByIndex,
  addStaticStream: (record) => addStaticStream(record, exportHooks),
};

function connect(): void {
  const port = chrome.runtime.connect({ name: PANEL_PORT });
  port.postMessage({
    type: "init",
    tabId: chrome.devtools.inspectedWindow.tabId,
  });

  port.onMessage.addListener((msg: RelayMessage) => {
    handleRelay(msg);
  });

  port.onDisconnect.addListener(() => {
    setTimeout(connect, 500);
  });
}

function handleRelay(msg: RelayMessage): void {
  switch (msg.type) {
    case "stream-start":
      onStart(msg.payload);
      break;
    case "stream-chunk":
      onChunk(msg.payload);
      break;
    case "stream-end":
      onEnd(msg.payload);
      break;
    case "stream-error":
      onError(msg.payload);
      break;
    case "stream-reconnect":
      onReconnect(msg.payload);
      break;
    case "stream-discard":
      onDiscard(msg.payload.requestId);
      break;
  }
}

function stampEvents(events: ParsedSseEvent[], previousReceivedAt?: number): SseEvent[] {
  return stampReceivedAt(events, { previousReceivedAt });
}

function createParser(kind: StreamKind): StreamParser {
  if (kind === "ndjson") return new NdjsonParser();
  if (kind === "connect-json") return new ConnectJsonParser();
  return new SseParser();
}

function onStart(payload: StreamStartPayload): void {
  const existing = state.streams.get(payload.requestId);
  if (existing) {
    // Merge header metadata into a provisional row without wiping chunks already received.
    existing.url = payload.url;
    existing.method = payload.method;
    existing.status = payload.status ?? existing.status;
    existing.statusText = payload.statusText ?? existing.statusText;
    existing.contentType = payload.contentType ?? existing.contentType;
    existing.requestHeaders = payload.requestHeaders ?? existing.requestHeaders;
    existing.responseHeaders = payload.responseHeaders ?? existing.responseHeaders;
    existing.requestPayloadPreview =
      payload.requestPayloadPreview ?? existing.requestPayloadPreview;
    existing.requestPayloadTruncated =
      payload.requestPayloadTruncated ?? existing.requestPayloadTruncated;
    existing.transport = payload.transport;
    const prevKind = existing.streamKind;
    existing.streamKind = payload.streamKind;
    existing.startedAt = payload.startedAt;
    // Provisional announce may guess wrong (sse vs connect-json); swap parser when kind changes.
    if (!state.parsers.has(payload.requestId) || prevKind !== payload.streamKind) {
      const parser = createParser(payload.streamKind);
      state.parsers.set(payload.requestId, parser);
      // Chunks may have arrived under the wrong parser (postMessage race). Rebuild events from raw.
      if (prevKind !== payload.streamKind && existing.raw) {
        existing.events = [];
        const rebuilt = stampEvents(
          [...parser.push(existing.raw), ...parser.flush()],
          existing.startedAt - 1,
        );
        existing.events.push(...rebuilt);
        discardConversationMergeSession(payload.requestId);
        getConversationMergeSession(payload.requestId).push(existing.events, existing.url);
      }
    }
    if (state.uiPaused) {
      state.pendingListRefreshWhilePaused = true;
      if (state.selectedId === payload.requestId) state.pendingDetailRefreshWhilePaused = true;
    } else {
      renderList();
      if (state.selectedId === payload.requestId) {
        renderDetail(true);
      }
    }
    return;
  }

  const record: StreamRecord = {
    requestId: payload.requestId,
    url: payload.url,
    method: payload.method,
    status: payload.status,
    statusText: payload.statusText,
    contentType: payload.contentType,
    requestHeaders: payload.requestHeaders,
    responseHeaders: payload.responseHeaders,
    requestPayloadPreview: payload.requestPayloadPreview,
    requestPayloadTruncated: payload.requestPayloadTruncated,
    transport: payload.transport,
    streamKind: payload.streamKind,
    startedAt: payload.startedAt,
    streamStatus: "streaming",
    raw: "",
    events: [],
    origin: "live",
  };
  state.streams.set(payload.requestId, record);
  state.parsers.set(payload.requestId, createParser(payload.streamKind));

  if (!state.selectedId) {
    state.selectedId = payload.requestId;
    if (state.selectedSidebarKeys.size === 0) {
      state.selectedSidebarKeys.add(`stream:${payload.requestId}`);
      state.selectionAnchorKey = `stream:${payload.requestId}`;
    }
  }

  if (state.uiPaused) {
    state.pendingListRefreshWhilePaused = true;
    if (state.selectedId === payload.requestId) state.pendingDetailRefreshWhilePaused = true;
  } else {
    renderList();
    if (state.selectedId === payload.requestId) {
      state.selectedEventIndex = null;
      renderDetail();
    }
  }
}

function onDiscard(requestId: string): void {
  const existing = state.streams.get(requestId);
  if (!existing) return;
  state.streams.delete(requestId);
  state.selectedSidebarKeys.delete(`stream:${requestId}`);
  state.parsers.delete(requestId);
  discardConversationMergeSession(requestId);
  invalidateStreamAnomalyCache(requestId);
  if (state.selectedId === requestId) {
    state.selectedId = null;
    state.selectedEventIndex = null;
    const fallbackSelected = Array.from(state.selectedSidebarKeys)
      .map(primaryStreamIdForSidebarKey)
      .find((id): id is string => Boolean(id));
    const next = fallbackSelected ?? Array.from(state.streams.keys())[0] ?? null;
    state.selectedId = next;
    if (state.selectedSidebarKeys.size === 0 && next) {
      state.selectedSidebarKeys.add(`stream:${next}`);
      state.selectionAnchorKey = `stream:${next}`;
    }
  }
  if (state.uiPaused) {
    state.pendingListRefreshWhilePaused = true;
    state.pendingDetailRefreshWhilePaused = true;
    return;
  }
  renderList();
  renderDetail();
}

function onChunk(payload: StreamChunkPayload): void {
  const record = state.streams.get(payload.requestId);
  const parser = state.parsers.get(payload.requestId);
  if (!record || !parser) return;

  record.raw += payload.text;
  const prevAt = record.events.length
    ? record.events[record.events.length - 1]!.receivedAt
    : undefined;
  const events = stampEvents(parser.push(payload.text), prevAt);
  if (events.length) {
    record.events.push(...events);
    const latestId = latestEventIdFromEvents(events);
    if (latestId) record.lastEventId = latestId;
  }
  // Keep merge session caught up so Conversation tab opens without a full re-parse.
  getConversationMergeSession(payload.requestId).push(record.events, record.url);

  if (state.uiPaused) {
    state.pendingListRefreshWhilePaused = true;
    if (state.selectedId === payload.requestId) state.pendingDetailRefreshWhilePaused = true;
    return;
  }
  // XHR can emit very frequent tiny deltas; avoid nuking the list DOM on every chunk.
  scheduleRenderList();
  if (
    state.selectedId === payload.requestId ||
    (state.activeTab === "conversation" && selectionSharesChatgptTurn(payload.requestId))
  ) {
    scheduleRenderDetail(true);
  }
}

function selectionSharesChatgptTurn(requestId: string): boolean {
  if (!state.selectedId || state.selectedId === requestId) return false;
  const selected = state.streams.get(state.selectedId);
  const changed = state.streams.get(requestId);
  if (!selected || !changed) return false;
  const all = state.streams.values();
  const selectedKey = chatgptMotherTurnKey(selected, all);
  return Boolean(
    selectedKey && selectedKey === chatgptMotherTurnKey(changed, state.streams.values()),
  );
}

function primaryStreamIdForSidebarKey(key: string): string | null {
  if (key.startsWith("stream:")) {
    const id = key.slice("stream:".length);
    return state.streams.has(id) ? id : null;
  }
  if (key.startsWith("turn:")) {
    const turnKey = key.slice("turn:".length);
    const group = resolveChatgptTurnGroups(state.streams.values()).find(
      (item) => item.key === turnKey,
    );
    return group?.records.at(-1)?.requestId ?? null;
  }
  return null;
}

function sidebarSelectionOrder(): string[] {
  return Array.from(elList.querySelectorAll<HTMLElement>("[data-selection-key]"))
    .map((node) => node.dataset.selectionKey)
    .filter((key): key is string => Boolean(key));
}

function applySidebarSelection(key: string, event: PointerEvent): void {
  const additive = event.ctrlKey || event.metaKey;
  if (event.shiftKey && state.selectionAnchorKey) {
    const order = sidebarSelectionOrder();
    const from = order.indexOf(state.selectionAnchorKey);
    const to = order.indexOf(key);
    if (from >= 0 && to >= 0) {
      if (!additive) state.selectedSidebarKeys.clear();
      const [start, end] = from <= to ? [from, to] : [to, from];
      for (let i = start; i <= end; i += 1) state.selectedSidebarKeys.add(order[i]!);
    } else {
      state.selectedSidebarKeys.clear();
      state.selectedSidebarKeys.add(key);
    }
  } else if (additive) {
    if (state.selectedSidebarKeys.has(key)) state.selectedSidebarKeys.delete(key);
    else state.selectedSidebarKeys.add(key);
    state.selectionAnchorKey = key;
  } else {
    state.selectedSidebarKeys.clear();
    state.selectedSidebarKeys.add(key);
    state.selectionAnchorKey = key;
  }

  if (!event.shiftKey && !additive) state.selectionAnchorKey = key;

  if (state.selectedSidebarKeys.has(key)) {
    state.selectedId = primaryStreamIdForSidebarKey(key);
  } else if (state.selectedId && !state.selectedSidebarKeys.has(`stream:${state.selectedId}`)) {
    const fallback = Array.from(state.selectedSidebarKeys)
      .map(primaryStreamIdForSidebarKey)
      .find((id): id is string => Boolean(id));
    state.selectedId = fallback ?? null;
  }
  state.selectedEventIndex = null;
}

function onEnd(payload: StreamEndPayload): void {
  const record = state.streams.get(payload.requestId);
  const parser = state.parsers.get(payload.requestId);
  if (!record) return;

  if (parser) {
    const prevAt = record.events.length
      ? record.events[record.events.length - 1]!.receivedAt
      : undefined;
    const rest = stampEvents(parser.flush(), prevAt);
    if (rest.length) {
      record.events.push(...rest);
      const latestId = latestEventIdFromEvents(rest);
      if (latestId) record.lastEventId = latestId;
    }
  }

  record.streamStatus = "done";
  record.endedAt = payload.endedAt;
  record.closeReason = payload.closeReason ?? "complete";
  record.metrics = computeStreamMetrics(record);
  if (state.uiPaused) {
    state.pendingListRefreshWhilePaused = true;
    if (state.selectedId === payload.requestId) state.pendingDetailRefreshWhilePaused = true;
    return;
  }
  renderList();
  if (state.selectedId === payload.requestId || selectionSharesChatgptTurn(payload.requestId)) {
    renderDetail(true);
  }
}

function onError(payload: StreamErrorPayload): void {
  const record = state.streams.get(payload.requestId);
  if (!record) return;

  // Chat clients commonly abort/cancel the underlying fetch after emitting an
  // application-level terminal marker. Treat that cleanup abort as success.
  if (payload.closeReason === "abort" && streamHasExplicitCompletion(record.events)) {
    record.streamStatus = "done";
    record.errorMessage = undefined;
    record.closeReason = "complete";
    record.endedAt = payload.endedAt;
    record.metrics = computeStreamMetrics(record);
    if (state.uiPaused) {
      state.pendingListRefreshWhilePaused = true;
      if (state.selectedId === payload.requestId) state.pendingDetailRefreshWhilePaused = true;
      return;
    }
    renderList();
    if (state.selectedId === payload.requestId || selectionSharesChatgptTurn(payload.requestId)) {
      renderDetail(true);
    }
    return;
  }
  record.streamStatus = "error";
  record.errorMessage = payload.message;
  record.closeReason = payload.closeReason ?? "error";
  record.endedAt = payload.endedAt;
  record.metrics = computeStreamMetrics(record);
  if (state.uiPaused) {
    state.pendingListRefreshWhilePaused = true;
    if (state.selectedId === payload.requestId) state.pendingDetailRefreshWhilePaused = true;
    return;
  }
  renderList();
  if (state.selectedId === payload.requestId || selectionSharesChatgptTurn(payload.requestId)) {
    renderDetail();
  }
}

function onReconnect(payload: StreamReconnectPayload): void {
  const record = state.streams.get(payload.requestId);
  if (!record) return;
  record.reconnectCount = payload.reconnectCount;
  if (payload.lastEventId) {
    record.lastEventId = payload.lastEventId;
  }
  const mark = {
    at: payload.at,
    reconnectCount: payload.reconnectCount,
    lastEventId: payload.lastEventId,
  };
  if (!record.reconnects) record.reconnects = [mark];
  else record.reconnects.push(mark);

  if (state.uiPaused) {
    state.pendingListRefreshWhilePaused = true;
    if (state.selectedId === payload.requestId) state.pendingDetailRefreshWhilePaused = true;
    return;
  }
  renderList();
  if (state.selectedId === payload.requestId) {
    renderDetail(true);
  }
}

function renderStreamMeta(record: StreamRecord | undefined): void {
  if (!record) {
    elMeta.classList.add("is-empty");
    elMetaMethod.textContent = "";
    elMetaUrl.textContent = t("selectStream");
    elMetaUrl.title = "";
    elMetaTags.innerHTML = "";
    return;
  }

  elMeta.classList.remove("is-empty");

  elMetaMethod.textContent = record.method;
  elMetaUrl.textContent = record.url;
  elMetaUrl.title = record.url;

  const bits: string[] = [];
  if (record.status != null) {
    const statusClass =
      record.streamStatus === "error" ? "error" : record.status >= 400 ? "error" : "ok";
    const statusText =
      record.statusText && record.statusText.trim()
        ? `${record.status} ${record.statusText}`
        : `HTTP ${record.status}`;
    bits.push(`<b class="meta-chip ${statusClass}">${escapeHtml(statusText)}</b>`);
  }
  if (record.contentType) {
    bits.push(`<span class="meta-chip">${escapeHtml(record.contentType)}</span>`);
  }
  const durationMs =
    typeof record.endedAt === "number"
      ? record.endedAt - record.startedAt
      : Date.now() - record.startedAt;
  const timeChip =
    typeof record.endedAt === "number" && Number.isFinite(record.endedAt)
      ? `${formatTime(record.startedAt)} → ${formatTime(record.endedAt)}`
      : t("metaStarted", formatTime(record.startedAt));
  bits.push(`<span class="meta-chip">${escapeHtml(timeChip)}</span>`);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    bits.push(`<span class="meta-chip">${escapeHtml(formatDuration(durationMs))}</span>`);
  }
  if (record.closeReason && record.closeReason !== "complete") {
    bits.push(
      `<span class="meta-chip ${record.closeReason === "abort" ? "warn" : "error"}">${escapeHtml(
        closeReasonLabel(record.closeReason),
      )}</span>`,
    );
  }
  if (record.errorMessage) {
    bits.push(
      `<span class="meta-chip error">${escapeHtml(t("metaError", record.errorMessage))}</span>`,
    );
  }
  if (record.reconnectCount && record.reconnectCount > 0) {
    bits.push(
      `<span class="meta-chip warn">${escapeHtml(
        t("metaReconnects", String(record.reconnectCount)),
      )}</span>`,
    );
  }
  if (record.lastEventId) {
    bits.push(
      `<span class="meta-chip">${escapeHtml(t("metaLastEventId", record.lastEventId))}</span>`,
    );
  }
  elMetaTags.innerHTML = bits.join("");
}

function updateTabCounts(record: StreamRecord | undefined): void {
  if (elTabCountEvents) {
    if (record && record.events.length > 0) {
      elTabCountEvents.hidden = false;
      elTabCountEvents.textContent = String(record.events.length);
    } else {
      elTabCountEvents.hidden = true;
      elTabCountEvents.textContent = "";
    }
  }
  if (elTabCountRaw) {
    if (record && record.raw) {
      const kb = (record.raw.length / 1024).toFixed(record.raw.length >= 10240 ? 0 : 1);
      elTabCountRaw.hidden = false;
      elTabCountRaw.textContent = t("rawSizeKb", kb);
    } else {
      elTabCountRaw.hidden = true;
      elTabCountRaw.textContent = "";
    }
  }
  if (elTabCountConversation) {
    updateConversationTabCount(record);
  }
}

let convTabCountAt = 0;
let convTabCountEvents = -1;
let convTabCountRequestId: string | null = null;

function updateConversationTabCount(record: StreamRecord | undefined): void {
  if (!elTabCountConversation) return;
  if (!record || record.events.length === 0) {
    elTabCountConversation.hidden = true;
    elTabCountConversation.textContent = "";
    convTabCountRequestId = null;
    convTabCountEvents = -1;
    return;
  }

  const grouped = mergeChatgptTurnGroup(record, state.streams.values());
  const logicalRecord = grouped?.record ?? record;
  const merged = grouped?.conversation;
  const streaming = logicalRecord.streamStatus === "streaming";
  const sameStream = convTabCountRequestId === logicalRecord.requestId;
  const due =
    !streaming ||
    !sameStream ||
    Date.now() - convTabCountAt >= 400 ||
    logicalRecord.events.length - convTabCountEvents >= 20 ||
    state.activeTab === "conversation";

  if (!due && sameStream) return;

  const resolvedMerged =
    merged ??
    syncConversationMergeSession(logicalRecord.requestId, logicalRecord.events, logicalRecord.url);
  convTabCountAt = Date.now();
  convTabCountEvents = logicalRecord.events.length;
  convTabCountRequestId = logicalRecord.requestId;

  if (conversationHasContent(resolvedMerged)) {
    elTabCountConversation.hidden = false;
    const n =
      (resolvedMerged.channels.content ? 1 : 0) +
      (resolvedMerged.channels.reasoning ? 1 : 0) +
      (resolvedMerged.channels.tools.length > 0 ? 1 : 0);
    elTabCountConversation.textContent = String(Math.max(n, 1));
  } else {
    elTabCountConversation.hidden = true;
    elTabCountConversation.textContent = "";
  }
}

/** Min gap between coalesced detail paints during high-frequency stream-chunk. */
const DETAIL_MIN_INTERVAL_MS = 100;

let detailRenderScheduled = false;
let detailRenderAppendFriendly = false;
let detailThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let detailRenderToken = 0;
let lastDetailRenderAt = 0;

function scheduleRenderDetail(appendFriendly = false): void {
  detailRenderAppendFriendly = detailRenderAppendFriendly || appendFriendly;
  if (detailRenderScheduled) return;
  detailRenderScheduled = true;
  const token = ++detailRenderToken;
  const delay = Math.max(0, DETAIL_MIN_INTERVAL_MS - (Date.now() - lastDetailRenderAt));

  const fire = (): void => {
    detailThrottleTimer = null;
    requestAnimationFrame(() => {
      if (token !== detailRenderToken) return;
      detailRenderScheduled = false;
      const append = detailRenderAppendFriendly;
      detailRenderAppendFriendly = false;
      lastDetailRenderAt = Date.now();
      paintDetail(append);
    });
  };

  if (delay === 0) {
    fire();
  } else {
    detailThrottleTimer = setTimeout(fire, delay);
  }
}

function renderDetail(appendFriendly = false): void {
  // Invalidate any pending coalesced paint so sync callers win immediately.
  detailRenderToken += 1;
  if (detailThrottleTimer != null) {
    clearTimeout(detailThrottleTimer);
    detailThrottleTimer = null;
  }
  detailRenderScheduled = false;
  const append = appendFriendly || detailRenderAppendFriendly;
  detailRenderAppendFriendly = false;
  lastDetailRenderAt = Date.now();
  paintDetail(append);
}

function paintDetail(appendFriendly = false): void {
  const record = state.selectedId ? state.streams.get(state.selectedId) : undefined;
  if (!record) {
    renderStreamMeta(undefined);
    updateTabCounts(undefined);
    clearEventsView();
    resetRawView();
    renderTimelineForSelection(undefined);
    renderRequestForSelection(undefined);
    renderConversationForSelection(undefined);
    return;
  }

  renderStreamMeta(record);
  updateTabCounts(record);

  // Only paint the active detail tab; inactive panes refresh on tab click.
  if (state.activeTab === "events") {
    renderEvents(record, appendFriendly);
  } else if (state.activeTab === "timeline") {
    renderTimelineForSelection(record);
  } else if (state.activeTab === "request") {
    renderRequestForSelection(record);
  } else if (state.activeTab === "raw") {
    renderRawView(record);
  } else if (state.activeTab === "conversation") {
    renderConversationForSelection(record);
  }
}

function activateTab(tab: ActiveTab): void {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((node) => {
    const btn = node as HTMLButtonElement;
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${tab}`)?.classList.add("active");
}

function loadTourSampleStream(): void {
  addStaticStream(buildTourSampleRecord(), exportHooks);
  activateTab("conversation");
  const record = state.selectedId ? state.streams.get(state.selectedId) : undefined;
  renderConversationForSelection(record);
  showToast(t("toastTourSampleLoaded"));
}

function getTourHooks(): OnboardingTourHooks {
  return {
    activateTab: (tab) => {
      activateTab(tab);
      const record = state.selectedId ? state.streams.get(state.selectedId) : undefined;
      if (tab === "events") {
        if (record) renderEvents(record, false);
        else clearEventsView();
      } else if (tab === "request") {
        renderRequestForSelection(record);
      } else if (tab === "conversation") {
        renderConversationForSelection(record);
      } else if (tab === "timeline") {
        renderTimelineForSelection(record);
      }
    },
    openMoreMenu,
    closeMenus: closeAllMenus,
  };
}

function jumpToSelectedEventFromTimeline(eventIndex: number): void {
  const record = state.selectedId ? state.streams.get(state.selectedId) : undefined;
  if (!record) return;
  activateTab("events");
  selectEventByIndex(record, eventIndex, { scrollMode: "start" });
}

function renderTimelineForSelection(record: StreamRecord | undefined): void {
  renderTimeline(record, {
    selectedEventIndex: state.selectedEventIndex,
    onJumpToEvent: jumpToSelectedEventFromTimeline,
  });
}

function renderRequestForSelection(record: StreamRecord | undefined): void {
  renderRequest(record, {
    onBindJsonTreeContextMenu: bindJsonTreeContextMenu,
    copyText,
    onShowPayloadContextMenu: showContextMenu,
  });
}

function renderConversationForSelection(record: StreamRecord | undefined): void {
  if (!record) {
    renderConversation(undefined, { copyText, showToast });
    return;
  }
  const grouped = mergeChatgptTurnGroup(record, state.streams.values());
  renderConversation(grouped?.record ?? record, { copyText, showToast }, grouped?.conversation);
}

function setupTabs(): void {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab as ActiveTab;
      if (
        tab !== "events" &&
        tab !== "raw" &&
        tab !== "timeline" &&
        tab !== "request" &&
        tab !== "conversation"
      ) {
        return;
      }
      activateTab(tab);
      const record = state.selectedId ? state.streams.get(state.selectedId) : undefined;
      if (tab === "events") {
        if (record) renderEvents(record, false);
        else clearEventsView();
      } else if (tab === "timeline") {
        renderTimelineForSelection(record);
      } else if (tab === "request") {
        renderRequestForSelection(record);
      } else if (tab === "raw") {
        renderRawView(record);
      } else if (tab === "conversation") {
        renderConversationForSelection(record);
      }
    });
  });
}

function setupActions(): void {
  // Prefer pointerdown: XHR streaming may rewrite row contents between mousedown/mouseup.
  elList.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const li = (e.target as HTMLElement | null)?.closest("li.stream, li.stream-item");
    if (!(li instanceof HTMLLIElement) || !elList.contains(li)) return;
    const turnKey = li.dataset.turnKey;
    const target = e.target as HTMLElement | null;
    if (turnKey && !li.dataset.id && target?.closest(".turn-group-caret")) {
      e.preventDefault();
      if (state.expandedTurnGroups.has(turnKey)) state.expandedTurnGroups.delete(turnKey);
      else state.expandedTurnGroups.add(turnKey);
      renderList();
      return;
    }
    const selectionKey = li.dataset.selectionKey;
    if (!selectionKey) return;
    e.preventDefault();
    applySidebarSelection(selectionKey, e);
    renderList();
    renderDetail();
  });

  document.getElementById("btn-clear")?.addEventListener("click", () => {
    state.streams.clear();
    state.parsers.clear();
    clearStreamAnomalyCaches();
    clearConversationMergeSessions();
    resetRequestViewState();
    resetConversationView();
    resetRawView();
    state.selectedId = null;
    state.selectedEventIndex = null;
    state.streamsUrlFilterQuery = "";
    state.streamsTransportFilter = "all";
    state.expandedTurnGroups.clear();
    state.selectedSidebarKeys.clear();
    state.selectionAnchorKey = null;
    state.pendingListRefreshWhilePaused = false;
    state.pendingDetailRefreshWhilePaused = false;
    elStreamsUrlFilter.value = "";
    elStreamsTransportFilter.value = "all";
    renderList();
    renderDetail();
  });

  elExportMenuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(elExportMenuPanel, elExportMenuBtn);
  });

  elMoreMenuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(elMoreMenuPanel, elMoreMenuBtn);
  });

  elThemeMenuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(elThemeMenuPanel, elThemeMenuBtn);
  });

  elExportMenuPanel?.addEventListener("click", () => {
    closeAllMenus();
  });

  elMoreMenuPanel?.addEventListener("click", () => {
    closeAllMenus();
  });

  for (const btn of [elThemeSystem, elThemeLight, elThemeNight]) {
    btn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const pref = btn.dataset.themePref as ThemePreference | undefined;
      if (pref !== "system" && pref !== "light" && pref !== "night") return;
      void setThemePreference(pref).then(() => {
        refreshThemeUi();
        closeAllMenus();
      });
    });
  }

  elExportJson.addEventListener("click", () => {
    exportSelectedStreamJson();
  });

  elExportCsv.addEventListener("click", () => {
    exportSelectedStreamCsv(exportHooks);
  });

  elExportFixture.addEventListener("click", () => {
    exportSelectedStreamFixture();
  });

  elExportRaw.addEventListener("click", () => {
    exportSelectedRawStreams();
  });

  elImportJson.addEventListener("click", () => {
    elImportFile.value = "";
    elImportFile.click();
  });

  elImportFile.addEventListener("change", () => {
    const file = elImportFile.files?.[0];
    if (!file) return;
    void importStreamFromFile(file, exportHooks).catch((err) => {
      window.alert(t("importFailed", err instanceof Error ? err.message : String(err)));
    });
  });

  elSaveArchive.addEventListener("click", () => {
    void saveSelectedStreamArchive().catch((err) => {
      window.alert(t("archiveSaveFailed", err instanceof Error ? err.message : String(err)));
    });
  });

  elArchives.addEventListener("click", () => {
    void showArchivesDialog(dialogHooks).catch((err) => {
      window.alert(t("archivesOpenFailed", err instanceof Error ? err.message : String(err)));
    });
  });

  elStats.addEventListener("click", () => {
    showStatsDialog();
  });

  elAnomalies.addEventListener("click", () => {
    showAnomaliesDialog(dialogHooks);
  });

  elSpecWarnings.addEventListener("click", () => {
    showSpecWarningsDialog(dialogHooks);
  });

  elSearchAll.addEventListener("click", () => {
    showGlobalSearchDialog(dialogHooks);
  });

  elPauseUi.addEventListener("click", () => {
    setUiPaused(!state.uiPaused, pauseHooks);
  });

  elDialogClose.addEventListener("click", () => {
    closeAppDialog();
  });

  elDialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeAppDialog();
  });

  document.getElementById("btn-copy-raw")?.addEventListener("click", async () => {
    const record = state.selectedId ? state.streams.get(state.selectedId) : undefined;
    if (!record) return;
    await copyText(record.raw, true);
  });

  document.getElementById("btn-settings")?.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });

  document.getElementById("btn-replay-tour")?.addEventListener("click", () => {
    startOnboardingTour(getTourHooks());
  });

  document.getElementById("btn-load-tour-sample")?.addEventListener("click", () => {
    loadTourSampleStream();
  });

  elDrawerClose.addEventListener("click", () => {
    closeDrawer();
  });

  elDrawerPrev.addEventListener("click", () => {
    navigateDrawer(-1);
  });

  elDrawerNext.addEventListener("click", () => {
    navigateDrawer(1);
  });

  elDrawerCopy.addEventListener("click", async () => {
    if (state.drawerEventData == null) return;
    await copyText(state.drawerEventData, true);
  });

  elEventsSearch.addEventListener("input", () => {
    state.eventsSearchQuery = elEventsSearch.value;
    applyEventsFilter();
    updateDrawerNavButtons();
  });

  elStreamsUrlFilter.addEventListener("input", () => {
    state.streamsUrlFilterQuery = elStreamsUrlFilter.value;
    renderList();
  });

  elStreamsTransportFilter.addEventListener("change", () => {
    const value = elStreamsTransportFilter.value;
    state.streamsTransportFilter =
      value === "fetch" || value === "eventsource" || value === "xhr" || value === "websocket"
        ? value
        : "all";
    renderList();
  });

  elDrawerSearch.addEventListener("input", () => {
    state.drawerSearchQuery = elDrawerSearch.value;
    applyDrawerSearch();
  });

  elContextMenu.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "copy-data" && state.contextMenuData?.kind === "event-data") {
      await copyText(state.contextMenuData.data, true);
    } else if (action === "copy-json-value" && state.contextMenuData?.kind === "json-node") {
      if (state.contextMenuData.value != null) {
        await copyText(state.contextMenuData.value, true);
      }
    } else if (action === "copy-json-path" && state.contextMenuData?.kind === "json-node") {
      await copyText(state.contextMenuData.path, true);
    }
    hideContextMenu();
  });

  document.addEventListener("click", (e) => {
    const target = e.target as Node | null;
    const inContextMenu = Boolean(target && elContextMenu.contains(target));
    // Menu item handler owns dismiss; don't clear payload mid-action.
    if (!inContextMenu) {
      hideContextMenu();
    }
    if (
      (elExportMenu && target && elExportMenu.contains(target)) ||
      (elMoreMenu && target && elMoreMenu.contains(target)) ||
      (elThemeMenu && target && elThemeMenu.contains(target))
    ) {
      return;
    }
    closeAllMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideContextMenu();
      closeAllMenus();
      return;
    }
    if (elDrawer.hidden) return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      navigateDrawer(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      navigateDrawer(1);
    }
  });
  window.addEventListener("blur", () => {
    hideContextMenu();
    closeAllMenus();
  });
  elTableWrap.addEventListener("scroll", () => hideContextMenu());
}

function setupSidebarResizer(): void {
  const SIDEBAR_MIN = 265;
  const SIDEBAR_MAX = 640;

  const readSidebarWidth = (): number => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar").trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 286;
  };

  elSidebarResizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.pageX;
    const startWidth = readSidebarWidth();

    elSidebarResizer.classList.add("resizing");

    const onMove = (ev: MouseEvent) => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + (ev.pageX - startX)));
      document.documentElement.style.setProperty("--sidebar", `${next}px`);
    };

    const onUp = () => {
      elSidebarResizer.classList.remove("resizing");
      document.body.classList.remove("is-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    document.body.classList.add("is-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function setupResizer(): void {
  applyDrawerWidth();

  elResizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const rect = elEvents.getBoundingClientRect();
      if (rect.width <= 0) return;
      const fromRight = ((rect.right - ev.clientX) / rect.width) * 100;
      state.drawerWidthPercent = Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, fromRight));
      applyDrawerWidth();
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

setupTabs();
setupActions();
setupSidebarResizer();
setupResizer();
initEventsColumnResizers(document.getElementById("events-table") as HTMLTableElement);
applyIcons();

function themePreferenceIcon(pref: ThemePreference): IconName {
  if (pref === "light") return "sun";
  if (pref === "night") return "moon";
  return "monitor";
}

function refreshThemeUi(): void {
  const pref = getActiveThemePreference();
  for (const btn of [elThemeSystem, elThemeLight, elThemeNight]) {
    if (!btn) continue;
    const active = btn.dataset.themePref === pref;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  }
  const iconEl = elThemeMenuBtn?.querySelector(".tool-icon");
  if (iconEl) {
    iconEl.outerHTML = renderIcon(themePreferenceIcon(pref), "tool-icon");
  }
}

function refreshLocaleUi(): void {
  document.documentElement.lang = uiLanguage();
  document.title = t("panelTitle");
  applyDomI18n();
  setUiPaused(state.uiPaused, pauseHooks);
  if (elStatusbarLocale) {
    const version = chrome.runtime.getManifest?.().version ?? "1.2.6";
    elStatusbarLocale.textContent =
      getActiveLocale() === "zh_CN" ? `中文 · ${version}` : `EN · ${version}`;
  }
  if (elStatusbarCapture && !state.uiPaused) {
    elStatusbarCapture.textContent = t("statusbarCaptureActive");
  }
  refreshStatusbarSummary();
  refreshThemeUi();
  renderList();
  renderDetail();
  refreshTourI18n();
}

void initI18n().then(async () => {
  refreshLocaleUi();
  await initTheme();
  refreshThemeUi();
  onThemeChange(() => {
    refreshThemeUi();
  });
  connect();
  onLocaleChange(() => {
    refreshLocaleUi();
  });
  // Defer one frame so layout has settled before measuring tour targets.
  requestAnimationFrame(() => {
    void maybeStartOnboardingTour(getTourHooks());
  });
});
