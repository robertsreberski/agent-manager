import {
  parseStateEvent,
  WireUpgradeRequiredError,
  type StateEvent,
  type StateEventType,
} from "../../../src/shared/wire.ts";
import type { ConnectionState } from "../types";

export type CockpitEvent = StateEvent;

const EVENT_TYPES: StateEventType[] = [
  "snapshot",
  "session.upsert",
  "session.remove",
  "action.updated",
  "diagnostic",
];

export function parseEvent(
  event: MessageEvent<string>,
  forcedType?: StateEventType,
): StateEvent | null {
  try {
    const parsed = parseStateEvent(JSON.parse(event.data) as unknown);
    return forcedType && parsed.type !== forcedType ? null : parsed;
  } catch (error) {
    if (error instanceof WireUpgradeRequiredError) throw error;
    return null;
  }
}

export function connectCockpitEvents(options: {
  clientId: string;
  onEvent: (event: StateEvent) => void;
  onConnection: (state: ConnectionState) => void;
  onReconnect: () => void;
  onUpgradeRequired: (error: WireUpgradeRequiredError) => void;
}): () => void {
  let openedOnce = false;
  let closed = false;
  const eventsUrl = new URL("/api/v1/events", window.location.href);
  eventsUrl.searchParams.set("clientId", options.clientId);
  const source = new EventSource(eventsUrl, { withCredentials: true });
  options.onConnection("connecting");

  const dispatch = (event: MessageEvent<string>, forcedType?: StateEventType): void => {
    if (closed) return;
    try {
      const parsed = parseEvent(event, forcedType);
      if (parsed) options.onEvent(parsed);
    } catch (error) {
      if (!(error instanceof WireUpgradeRequiredError)) throw error;
      closed = true;
      source.close();
      options.onUpgradeRequired(error);
    }
  };

  source.onopen = () => {
    if (closed) return;
    options.onConnection("open");
    if (openedOnce) options.onReconnect();
    openedOnce = true;
  };
  source.onerror = () => {
    if (!closed) options.onConnection(openedOnce ? "retrying" : "offline");
  };
  source.onmessage = (event) => {
    dispatch(event);
  };
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      dispatch(event as MessageEvent<string>, type);
    });
  }

  return () => {
    closed = true;
    source.close();
  };
}
