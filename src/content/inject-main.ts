import {
  CONTROL_SOURCE,
  MESSAGE_SOURCE,
  type CaptureControlMessage,
  type PageToExtensionMessage,
} from "../shared/types";
import { patchEventSource } from "./inject/patch-eventsource";
import { patchFetch } from "./inject/patch-fetch";
import { patchWebSocket } from "./inject/patch-websocket";
import { patchXhr } from "./inject/patch-xhr";
import type {
  PostChunk,
  PostDiscard,
  PostEnd,
  PostError,
  PostReconnect,
  PostStart,
} from "./inject/types";

const STATE_KEY = "__EVENTSTREAM_PANEL_INSTALLED__";

declare global {
  interface Window {
    [STATE_KEY]?: boolean;
  }
}

if (!window[STATE_KEY]) {
  window[STATE_KEY] = true;
  install();
}

function install(): void {
  let seq = 0;
  const nextId = () => `sse-${Date.now()}-${++seq}`;

  const post = (msg: PageToExtensionMessage): void => {
    window.postMessage(msg, "*");
  };

  const postStart: PostStart = (payload) =>
    post({ source: MESSAGE_SOURCE, type: "stream-start", payload });
  const postChunk: PostChunk = (payload) =>
    post({ source: MESSAGE_SOURCE, type: "stream-chunk", payload });
  const postEnd: PostEnd = (payload) =>
    post({ source: MESSAGE_SOURCE, type: "stream-end", payload });
  const postError: PostError = (payload) =>
    post({ source: MESSAGE_SOURCE, type: "stream-error", payload });
  const postReconnect: PostReconnect = (payload) =>
    post({ source: MESSAGE_SOURCE, type: "stream-reconnect", payload });
  const postDiscard: PostDiscard = (requestId) =>
    post({ source: MESSAGE_SOURCE, type: "stream-discard", payload: { requestId } });

  let cleanups: Array<() => void> | null = null;

  const uninstallHooks = (): void => {
    if (cleanups) {
      for (const cleanup of [...cleanups].reverse()) cleanup();
    }
    cleanups = null;
  };

  const installHooks = (): void => {
    if (cleanups) return;
    cleanups = [
      patchFetch(nextId, postStart, postChunk, postEnd, postError, postDiscard),
      patchEventSource(nextId, postStart, postChunk, postEnd, postError, postReconnect),
      patchXhr(nextId, postStart, postChunk, postEnd, postError, postDiscard),
      patchWebSocket(nextId, postStart, postChunk, postEnd, postError),
    ];
  };

  const setCaptureEnabled = (enabled: boolean): void => {
    if (enabled) {
      // The service worker sends capture-control on every panel heartbeat.
      // Never reinstall over another script's hook: that script may still
      // delegate to ours, creating an unbounded nesting of fetch wrappers.
      installHooks();
      return;
    }

    uninstallHooks();
  };

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    const message = event.data as CaptureControlMessage;
    if (message.source !== CONTROL_SOURCE || message.type !== "capture-control") return;
    setCaptureEnabled(Boolean(message.payload?.enabled));
  });
}
