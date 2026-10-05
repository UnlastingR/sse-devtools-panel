import {
  CONTROL_SOURCE,
  MESSAGE_SOURCE,
  type CaptureControlMessage,
  type CaptureStateRequestMessage,
  type PageToExtensionMessage,
} from "../shared/types";

const PAGE_MESSAGE_TYPES = new Set([
  "stream-start",
  "stream-chunk",
  "stream-end",
  "stream-error",
  "stream-reconnect",
  "stream-discard",
]);

function isPageMessage(data: unknown): data is PageToExtensionMessage {
  if (!data || typeof data !== "object") return false;
  const msg = data as PageToExtensionMessage;
  return (
    msg.source === MESSAGE_SOURCE &&
    typeof msg.type === "string" &&
    PAGE_MESSAGE_TYPES.has(msg.type) &&
    "payload" in msg
  );
}

function postCaptureControl(enabled: boolean): void {
  const message: CaptureControlMessage = {
    source: CONTROL_SOURCE,
    type: "capture-control",
    payload: { enabled },
  };
  window.postMessage(message, "*");
}

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages from the same window
  if (event.source !== window) return;
  if (!isPageMessage(event.data)) return;

  try {
    chrome.runtime.sendMessage(event.data);
  } catch {
    // Extension context invalidated (reload) — ignore
  }
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object") return;
  const control = message as CaptureControlMessage;
  if (control.source !== CONTROL_SOURCE || control.type !== "capture-control") return;
  postCaptureControl(Boolean(control.payload?.enabled));
});

// A tab can reload while the DevTools panel remains connected. Ask the service worker
// for the current capture state so the freshly injected page-world listener catches up.
const stateRequest: CaptureStateRequestMessage = {
  source: CONTROL_SOURCE,
  type: "capture-state-request",
};
void chrome.runtime
  .sendMessage(stateRequest)
  .then((response: { enabled?: boolean } | undefined) => {
    postCaptureControl(Boolean(response?.enabled));
  })
  .catch(() => {
    // Extension context may be reloading; capture stays disabled by default.
  });
