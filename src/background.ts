import {
  CONTROL_SOURCE,
  MESSAGE_SOURCE,
  PANEL_PORT,
  type CaptureControlMessage,
  type CaptureStateRequestMessage,
  type PageToExtensionMessage,
  type RelayMessage,
} from "./shared/types";
import { estimateRelayBytes, RelayBuffer } from "./shared/relay-buffer";

/** tabId → set of DevTools panel ports */
const panelPorts = new Map<number, Set<chrome.runtime.Port>>();
/** Tabs currently replaying buffered messages onto a newly attached panel. */
const attachingTabs = new Set<number>();
/** Short grace timers before disabling page capture after the last panel disappears. */
const captureDisableTimers = new Map<number, ReturnType<typeof setTimeout>>();

const BUFFER_MAX_MESSAGES = 2_000;
/** Room for a few large request payloads while the panel is closed. */
const BUFFER_MAX_BYTES = 16 * 1024 * 1024;

type BufferedRelayMessage = { type: string; byteSize: number; relay: RelayMessage };

const tabBuffers = new Map<number, RelayBuffer<BufferedRelayMessage>>();

function isPageMessage(msg: unknown): msg is PageToExtensionMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as PageToExtensionMessage;
  return m.source === MESSAGE_SOURCE && typeof m.type === "string";
}

function bufferFor(tabId: number): RelayBuffer<BufferedRelayMessage> {
  let buf = tabBuffers.get(tabId);
  if (!buf) {
    buf = new RelayBuffer({
      maxMessages: BUFFER_MAX_MESSAGES,
      maxBytes: BUFFER_MAX_BYTES,
    });
    tabBuffers.set(tabId, buf);
  }
  return buf;
}

function hasLivePorts(tabId: number): boolean {
  const ports = panelPorts.get(tabId);
  return Boolean(ports && ports.size > 0);
}

function setCaptureEnabled(tabId: number, enabled: boolean): void {
  const message: CaptureControlMessage = {
    source: CONTROL_SOURCE,
    type: "capture-control",
    payload: { enabled },
  };
  void chrome.tabs.sendMessage(tabId, message).catch(() => {
    // No content script yet (navigation/reload). bridge.ts requests state on startup.
  });
}

function cancelCaptureDisable(tabId: number): void {
  const timer = captureDisableTimers.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  captureDisableTimers.delete(tabId);
}

function scheduleCaptureDisable(tabId: number): void {
  cancelCaptureDisable(tabId);
  const timer = setTimeout(() => {
    captureDisableTimers.delete(tabId);
    if (!hasLivePorts(tabId)) setCaptureEnabled(tabId, false);
  }, 2_000);
  captureDisableTimers.set(tabId, timer);
}

/** Returns how many panel ports accepted the message. Failed ports are pruned immediately. */
function forwardToPorts(tabId: number, msg: RelayMessage): number {
  const ports = panelPorts.get(tabId);
  if (!ports || ports.size === 0) return 0;
  let delivered = 0;
  for (const port of [...ports]) {
    try {
      port.postMessage(msg);
      delivered += 1;
    } catch {
      // A dead DevTools port used to remain in panelPorts forever, causing all
      // later capture messages to disappear into a black hole until F12 was
      // closed/reopened. Prune it synchronously so the current message can be
      // buffered and the panel's reconnect loop can recover without data loss.
      ports.delete(port);
    }
  }
  if (ports.size === 0) {
    panelPorts.delete(tabId);
    scheduleCaptureDisable(tabId);
  }
  return delivered;
}

function enqueueOrForward(tabId: number, msg: RelayMessage): void {
  if (attachingTabs.has(tabId) || !hasLivePorts(tabId)) {
    bufferFor(tabId).push({
      type: msg.type,
      byteSize: estimateRelayBytes(msg),
      relay: msg,
    });
    return;
  }
  if (forwardToPorts(tabId, msg) > 0) return;
  bufferFor(tabId).push({
    type: msg.type,
    byteSize: estimateRelayBytes(msg),
    relay: msg,
  });
}

function replayToPort(port: chrome.runtime.Port, batch: BufferedRelayMessage[]): number {
  let delivered = 0;
  for (const item of batch) {
    try {
      port.postMessage(item.relay);
      delivered += 1;
    } catch {
      break;
    }
  }
  return delivered;
}

function attachPanel(tabId: number, port: chrome.runtime.Port): void {
  cancelCaptureDisable(tabId);
  attachingTabs.add(tabId);
  try {
    for (;;) {
      const batch = bufferFor(tabId).drain();
      if (batch.length === 0) break;
      const delivered = replayToPort(port, batch);
      if (delivered < batch.length) {
        for (const item of batch.slice(delivered)) bufferFor(tabId).push(item);
        return;
      }
    }

    let set = panelPorts.get(tabId);
    if (!set) {
      set = new Set();
      panelPorts.set(tabId, set);
    }
    set.add(port);
    if (set.size === 1) setCaptureEnabled(tabId, true);
  } finally {
    attachingTabs.delete(tabId);
  }

  // Messages buffered between last drain and live registration.
  for (;;) {
    const batch = bufferFor(tabId).drain();
    if (batch.length === 0) break;
    if (hasLivePorts(tabId)) {
      for (let i = 0; i < batch.length; i += 1) {
        const item = batch[i]!;
        if (forwardToPorts(tabId, item.relay) === 0) {
          for (const remaining of batch.slice(i)) bufferFor(tabId).push(remaining);
          break;
        }
      }
    } else {
      for (const item of batch) bufferFor(tabId).push(item);
      break;
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;

  let tabId: number | null = null;

  const onMessage = (msg: { type?: string; tabId?: number }) => {
    if (msg?.type === "init" && typeof msg.tabId === "number") {
      tabId = msg.tabId;
      attachPanel(tabId, port);
      return;
    }
    if (msg?.type === "heartbeat" && typeof msg.tabId === "number" && msg.tabId === tabId) {
      // Reassert capture on each heartbeat. This repairs a page/content-script
      // lifecycle race without requiring the user to toggle DevTools.
      setCaptureEnabled(msg.tabId, true);
    }
  };

  port.onMessage.addListener(onMessage);

  port.onDisconnect.addListener(() => {
    port.onMessage.removeListener(onMessage);
    if (tabId !== null) {
      const set = panelPorts.get(tabId);
      if (set) {
        set.delete(port);
        if (set.size === 0) {
          panelPorts.delete(tabId);
          // Give the panel's automatic reconnect a short window. Keeping capture
          // alive during the grace period lets background buffering bridge the gap.
          scheduleCaptureDisable(tabId);
        }
      }
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const stateRequest = message as CaptureStateRequestMessage;
  if (stateRequest?.source === CONTROL_SOURCE && stateRequest.type === "capture-state-request") {
    const tabId = sender.tab?.id;
    sendResponse({ enabled: typeof tabId === "number" && hasLivePorts(tabId) });
    return;
  }
  if (!isPageMessage(message)) return;
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return;

  const relay: RelayMessage = { ...message, tabId };
  enqueueOrForward(tabId, relay);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelCaptureDisable(tabId);
  panelPorts.delete(tabId);
  attachingTabs.delete(tabId);
  tabBuffers.delete(tabId);
});
