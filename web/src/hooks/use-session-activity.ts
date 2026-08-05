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
export function useSessionActivity(selectedId: string | null, retryGeneration = 0): SessionActivityView {
  const [view, setView] = useState<SessionActivityView>(() => emptySessionActivity(selectedId));
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    /*
      An explicit retry recreates a terminally closed EventSource. Keep the
      last internally consistent projection while that replacement loads; a
      retry is a transport operation, not permission to erase transcript
      history. A different selected session still starts from a clean view.
    */
    const initial = selectedId !== null && viewRef.current.sessionId === selectedId
      ? { ...viewRef.current, connection: "connecting" as const }
      : emptySessionActivity(selectedId);
    viewRef.current = initial;
    setView(initial);
    if (!selectedId) return;
    const sessionId = selectedId;

    let pending: ActivityFrame[] = [];
    let receivedFrame = false;
    let animationFrame: number | null = null;
    let disconnectActivity = (): void => undefined;
    const scheduleFrame: ScheduleFrame = requestBrowserFrame;
    const cancelFrame: CancelFrame = cancelBrowserFrame;

    const commit = () => {
      animationFrame = null;
      let next = viewRef.current;
      for (const frame of pending) {
        const reduction = reduceSessionActivity(next, sessionId, frame);
        if (reduction.requiresReset) {
          pending = [];
          restartFromSnapshot();
          return;
        }
        next = reduction.state;
      }
      if (receivedFrame && next.connection !== "open") {
        next = { ...next, connection: "open" };
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
    const preserveAfterTerminalError = () => {
      // A terminal EventSource failure says only that live delivery is
      // unavailable. The last fully reconciled snapshot is still valid
      // retained history and must remain visible while authentication, wire
      // cutover, or the service connection is repaired.
      const next = { ...viewRef.current, connection: "offline" as const };
      viewRef.current = next;
      pending = [];
      if (animationFrame !== null) {
        cancelFrame(animationFrame);
        animationFrame = null;
      }
      setView(next);
    };

    function startConnection(): void {
      disconnectActivity = connectSessionActivityEvents({
        sessionId,
        clientId: BROWSER_CLIENT_ID,
        onFrame: (frame) => {
          receivedFrame = true;
          pending.push(frame);
          if (animationFrame === null) animationFrame = scheduleFrame(commit);
        },
        onConnection: updateConnection,
        onTerminalError: preserveAfterTerminalError,
      });
    }
    function restartFromSnapshot(): void {
      disconnectActivity();
      // Keep the last internally consistent projection on screen while a fresh
      // baseline is fetched. Reset only the cursor identity so no subsequent
      // delta can apply to that retained projection before the snapshot lands.
      const next = {
        ...viewRef.current,
        streamEpoch: null,
        cursor: null,
        seq: null,
        connection: "connecting" as const,
      };
      viewRef.current = next;
      setView(next);
      startConnection();
    }

    startConnection();
    return () => {
      disconnectActivity();
      pending = [];
      if (animationFrame !== null) cancelFrame(animationFrame);
    };
  }, [retryGeneration, selectedId]);

  return useMemo(
    () => view.sessionId === selectedId ? view : emptySessionActivity(selectedId),
    [selectedId, view],
  );
}
