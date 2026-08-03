import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVITY_EVENT_TYPES,
  emptySessionActivity,
  parseActivityFrame,
  reduceSessionActivity,
} from "../lib/session-activity";
import type { ActivityFrame, ConnectionState, SessionActivityView } from "../types";
import { BROWSER_CLIENT_ID } from "./use-cockpit";

type ScheduleFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

function requestBrowserFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelBrowserFrame(handle: number): void {
  if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
  } else {
    window.clearTimeout(handle);
  }
}

export function connectSessionActivityEvents(options: {
  sessionId: string;
  clientId: string;
  onFrame: (frame: ActivityFrame) => void;
  onConnection: (connection: ConnectionState) => void;
  onTerminalError: () => void;
}): () => void {
  let closed = false;
  let openedOnce = false;
  const eventsUrl = new URL(
    `/api/v1/sessions/${encodeURIComponent(options.sessionId)}/activity/events`,
    window.location.href,
  );
  eventsUrl.searchParams.set("clientId", options.clientId);
  const source = new EventSource(eventsUrl, { withCredentials: true });
  options.onConnection("connecting");

  source.onopen = () => {
    if (closed) return;
    openedOnce = true;
    options.onConnection("open");
  };
  source.onerror = () => {
    if (closed) return;
    if (source.readyState === EventSource.CLOSED) {
      options.onConnection("offline");
      options.onTerminalError();
      return;
    }
    options.onConnection(openedOnce ? "retrying" : "offline");
  };
  source.onmessage = (event) => {
    const frame = parseActivityFrame(event);
    if (frame) options.onFrame(frame);
  };
  for (const type of ACTIVITY_EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      const frame = parseActivityFrame(event as MessageEvent<string>, type);
      if (frame) options.onFrame(frame);
    });
  }

  return () => {
    closed = true;
    source.close();
  };
}

/**
 * Owns the selected session's private activity cursor and view. Frame commits
 * are coalesced to one React update per animation frame so token deltas do not
 * make the whole cockpit render at provider frequency.
 */
export function useSessionActivity(selectedId: string | null): SessionActivityView {
  const [view, setView] = useState<SessionActivityView>(() => emptySessionActivity(selectedId));
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const initial = emptySessionActivity(selectedId);
    viewRef.current = initial;
    setView(initial);
    if (!selectedId) return;

    let pending: ActivityFrame[] = [];
    let animationFrame: number | null = null;
    const scheduleFrame: ScheduleFrame = requestBrowserFrame;
    const cancelFrame: CancelFrame = cancelBrowserFrame;

    const commit = () => {
      animationFrame = null;
      let next = viewRef.current;
      for (const frame of pending) {
        next = reduceSessionActivity(next, selectedId, frame).state;
      }
      pending = [];
      if (next !== viewRef.current) {
        viewRef.current = next;
        setView(next);
      }
    };
    const updateConnection = (connection: ConnectionState) => {
      const next = { ...viewRef.current, connection };
      viewRef.current = next;
      setView(next);
    };
    const clearAfterTerminalError = () => {
      const next = { ...emptySessionActivity(selectedId), connection: "offline" as const };
      viewRef.current = next;
      pending = [];
      if (animationFrame !== null) {
        cancelFrame(animationFrame);
        animationFrame = null;
      }
      setView(next);
    };

    const disconnect = connectSessionActivityEvents({
      sessionId: selectedId,
      clientId: BROWSER_CLIENT_ID,
      onFrame: (frame) => {
        pending.push(frame);
        if (animationFrame === null) animationFrame = scheduleFrame(commit);
      },
      onConnection: updateConnection,
      onTerminalError: clearAfterTerminalError,
    });
    return () => {
      disconnect();
      pending = [];
      if (animationFrame !== null) cancelFrame(animationFrame);
      viewRef.current = emptySessionActivity(null);
    };
  }, [selectedId]);

  return useMemo(
    () => view.sessionId === selectedId ? view : emptySessionActivity(selectedId),
    [selectedId, view],
  );
}
