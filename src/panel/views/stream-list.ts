import { t } from "../../shared/i18n";
import type { StreamRecord } from "../../shared/types";
import { elEmpty, elList } from "../core/dom";
import {
  closeReasonLabel,
  escapeHtml,
  formatDuration,
  formatTime,
  formatTimeShort,
  originLabel,
  shortPath,
  streamStatusShort,
  transportLabel,
} from "../core/format";
import { getStreamSpecWarnings, scanStreamAnomalies } from "../features/stream-anomalies";
import { state } from "../core/state";
import { refreshStatusbarSummary } from "../core/ui-chrome";
import { resolveChatgptTurnGroups } from "../../shared/chatgpt-logical-turn";

let listRenderScheduled = false;

export function scheduleRenderList(): void {
  if (listRenderScheduled) return;
  listRenderScheduled = true;
  requestAnimationFrame(() => {
    listRenderScheduled = false;
    renderList();
  });
}

export function streamItemFingerprint(s: StreamRecord): string {
  return [
    s.requestId === state.selectedId ? "1" : "0",
    s.streamStatus,
    s.transport,
    s.origin ?? "",
    String(s.status ?? ""),
    String(s.events.length),
    s.method,
    s.url,
    s.closeReason ?? "",
    String(s.reconnectCount ?? 0),
    s.lastEventId ?? "",
    s.errorMessage ?? "",
    String(s.startedAt),
    String(s.endedAt ?? ""),
  ].join("|");
}

function streamTimeTooltip(s: StreamRecord): string {
  const start = formatTime(s.startedAt);
  if (typeof s.endedAt === "number" && Number.isFinite(s.endedAt)) {
    const dur = formatDuration(Math.max(0, s.endedAt - s.startedAt));
    return t("streamTimeTooltipDone", [start, formatTime(s.endedAt), dur]);
  }
  return t("streamTimeTooltipLive", start);
}

export function renderList(): void {
  const urlFilter = state.streamsUrlFilterQuery.trim().toLowerCase();
  const all = Array.from(state.streams.values());
  const matches = (s: StreamRecord): boolean => {
    if (state.streamsTransportFilter !== "all" && s.transport !== state.streamsTransportFilter) {
      return false;
    }
    if (!urlFilter) return true;
    return s.url.toLowerCase().includes(urlFilter);
  };
  // Chat and Work share the same mother-event UI even when a turn currently
  // has only one physical stream. More continuation/upload children may arrive
  // later without changing the list shape underneath the user.
  const groups = resolveChatgptTurnGroups(all);
  const groupedIds = new Set(
    groups.flatMap((group) => group.records.map((record) => record.requestId)),
  );
  const standalone = all.filter((record) => !groupedIds.has(record.requestId) && matches(record));
  const entries = [
    ...groups
      .map((group) => ({
        type: "group" as const,
        group,
        visibleRecords: group.records.filter(matches),
        startedAt: group.records[0]?.startedAt ?? 0,
      }))
      .filter((entry) => entry.visibleRecords.length > 0),
    ...standalone.map((record) => ({
      type: "stream" as const,
      record,
      startedAt: record.startedAt,
    })),
  ].sort((a, b) => a.startedAt - b.startedAt);
  const itemsCount = entries.length;
  elEmpty.classList.toggle("hidden", itemsCount > 0);
  if (
    itemsCount === 0 &&
    state.streams.size > 0 &&
    (urlFilter || state.streamsTransportFilter !== "all")
  ) {
    elEmpty.className = "empty-hint empty-hint--filter";
    elEmpty.textContent = t("noStreamsMatchFilter");
  } else {
    elEmpty.className = "empty-hint";
    elEmpty.innerHTML = `
      <p class="empty-hint-lead">
        <span>${escapeHtml(t("emptyWaitingBefore"))}</span>
        <code>text/event-stream</code><span>${escapeHtml(t("emptyWaitingAfter"))}</span>
      </p>
      <p class="empty-hint-guide">${escapeHtml(t("emptyHintGuide"))}</p>
    `;
  }

  const renderStream = (s: StreamRecord, extraClass = ""): HTMLLIElement => {
    const li = document.createElement("li");
    li.dataset.id = s.requestId;
    const selectionKey = `stream:${s.requestId}`;
    li.dataset.selectionKey = selectionKey;
    li.className = `stream${extraClass ? ` ${extraClass}` : ""}${
      s.requestId === state.selectedId ? " active" : ""
    }${state.selectedSidebarKeys.has(selectionKey) ? " selected" : ""}`;
    const anomalyCount = scanStreamAnomalies(s).length;
    const specCount = getStreamSpecWarnings(s).length;
    const transportClass =
      s.transport === "fetch" ||
      s.transport === "xhr" ||
      s.transport === "eventsource" ||
      s.transport === "websocket"
        ? s.transport
        : "";
    const tip = escapeHtml(streamTimeTooltip(s));
    const endHtml =
      typeof s.endedAt === "number" && Number.isFinite(s.endedAt)
        ? `<time class="stream-when-end" datetime="${new Date(s.endedAt).toISOString()}" title="${tip}">${escapeHtml(
            formatTimeShort(s.endedAt),
          )}</time>`
        : "";
    li.innerHTML = `
        <div class="stream-head">
          <div class="stream-path" title="${escapeHtml(s.url)}"><span class="method">${escapeHtml(s.method)}</span>${escapeHtml(shortPath(s.url))}</div>
          <time class="stream-when-start" datetime="${new Date(s.startedAt).toISOString()}" title="${tip}">${escapeHtml(
            formatTimeShort(s.startedAt),
          )}</time>
        </div>
        <div class="stream-meta">
          <span class="badge ${transportClass}">${escapeHtml(transportLabel(s.transport))}</span>
          ${
            originLabel(s.origin)
              ? `<span class="badge origin">${escapeHtml(originLabel(s.origin) as string)}</span>`
              : ""
          }
          ${anomalyCount > 0 ? `<span class="badge warn" title="${escapeHtml(t("anomaliesTitle"))}">!${anomalyCount}</span>` : ""}
          ${specCount > 0 ? `<span class="badge spec" title="${escapeHtml(t("specWarningsTitle"))}">S${specCount}</span>` : ""}
          ${
            (s.reconnectCount ?? 0) > 0
              ? `<span class="badge reconnect" title="${escapeHtml(
                  t("reconnectBadgeTitle", String(s.reconnectCount)),
                )}">R${s.reconnectCount}</span>`
              : ""
          }
          ${
            s.closeReason === "abort"
              ? `<span class="badge abort" title="${escapeHtml(closeReasonLabel("abort"))}">${escapeHtml(
                  t("badgeAbort"),
                )}</span>`
              : ""
          }
          <span>${s.status != null ? `HTTP ${s.status}` : "—"}</span>
          <span>${escapeHtml(t("eventsCount", String(s.events.length)))}</span>
          <span class="stream-meta-trail">
            <span class="status ${s.streamStatus}"><i></i>${escapeHtml(streamStatusShort(s.streamStatus))}</span>
            ${endHtml}
          </span>
        </div>
      `;
    return li;
  };

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    if (entry.type === "stream") {
      fragment.appendChild(renderStream(entry.record));
      continue;
    }

    const { group, visibleRecords } = entry;
    const parent = document.createElement("li");
    const active = group.records.some((record) => record.requestId === state.selectedId);
    const expanded = state.expandedTurnGroups.has(group.key);
    const selectionKey = `turn:${group.key}`;
    const first = group.records[0]!;
    const last = group.records.at(-1)!;
    const anyStreaming = group.records.some((record) => record.streamStatus === "streaming");
    const totalEvents = group.records.reduce((sum, record) => sum + record.events.length, 0);
    const transports = Array.from(
      new Set(group.records.map((record) => transportLabel(record.transport))),
    );
    parent.className = `stream turn-group${active ? " active" : ""}${
      state.selectedSidebarKeys.has(selectionKey) ? " selected" : ""
    }${expanded ? " is-expanded" : ""}`;
    parent.dataset.turnKey = group.key;
    parent.dataset.selectionKey = selectionKey;
    parent.dataset.preferredId = visibleRecords.at(-1)?.requestId ?? last.requestId;
    const toggleLabel = t(expanded ? "turnCollapse" : "turnExpand");
    parent.innerHTML = `
      <div class="stream-head turn-group-head">
        <button type="button" class="turn-group-toggle" aria-expanded="${expanded ? "true" : "false"}" aria-label="${escapeHtml(toggleLabel)}" title="${escapeHtml(toggleLabel)}">
          <span class="turn-group-caret" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
        </button>
        <div class="stream-path" title="${escapeHtml(group.key)}"><span class="method">${
          group.profile === "chatgpt-web-work" ? "WORK" : "CHAT"
        }</span>Turn · ${escapeHtml(t("turnStreamsCount", String(visibleRecords.length)))}</div>
        <time class="stream-when-start">${escapeHtml(formatTimeShort(first.startedAt))}</time>
      </div>
      <div class="stream-meta">
        <span class="badge origin">${escapeHtml(group.profile === "chatgpt-web-work" ? "WORK TURN" : "CHAT TURN")}</span>
        <span>${escapeHtml(transports.join(" + "))}</span>
        <span>${escapeHtml(t("eventsCount", String(totalEvents)))}</span>
        <span class="stream-meta-trail">
          <span class="status ${anyStreaming ? "streaming" : last.streamStatus}"><i></i>${escapeHtml(
            streamStatusShort(anyStreaming ? "streaming" : last.streamStatus),
          )}</span>
          ${
            !anyStreaming && typeof last.endedAt === "number"
              ? `<time class="stream-when-end">${escapeHtml(formatTimeShort(last.endedAt))}</time>`
              : ""
          }
        </span>
      </div>
    `;
    if (expanded) {
      const children = document.createElement("ul");
      children.className = "turn-group-children";
      for (const child of visibleRecords) children.appendChild(renderStream(child, "stream-child"));
      parent.appendChild(children);
    }
    fragment.appendChild(parent);
  }
  elList.replaceChildren(fragment);

  refreshStatusbarSummary();
}
