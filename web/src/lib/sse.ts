import type { ConnectionState } from "../types";

export type CockpitEvent =
  | { type: "snapshot"; payload: unknown; seq: number | null }
  | { type: "session.upsert"; payload: unknown; seq: number | null }
  | { type: "session.remove"; payload: unknown; seq: number | null }
  | { type: "action.updated"; payload: unknown; seq: number | null }
  | { type: "diagnostic"; payload: unknown; seq: number | null };

const EVENT_TYPES: CockpitEvent["type"][] = [
  "snapshot",
  "session.upsert",
  "session.remove",
  "action.updated",
  "diagnostic",
];

export function parseEvent(
  event: MessageEvent<string>,
  forcedType?: CockpitEvent["type"],
): CockpitEvent | null {
  try {
    const decoded: unknown = JSON.parse(event.data);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const value = decoded as Record<string, unknown>;
    const embeddedType = typeof value.type === "string" ? value.type : null;
    if (forcedType && embeddedType && embeddedType !== forcedType) return null;
    const candidate = forcedType ?? embeddedType;
    if (!candidate || !EVENT_TYPES.includes(candidate as CockpitEvent["type"])) return null;
    return {
      type: candidate as CockpitEvent["type"],
      payload: Object.hasOwn(value, "payload") ? value.payload : value,
      seq: typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq >= 0
        ? value.seq
        : null,
    } as CockpitEvent;
  } catch {
    return null;
  }
}

export function connectCockpitEvents(options: {
  clientId: string;
  onEvent: (event: CockpitEvent) => void;
  onConnection: (state: ConnectionState) => void;
  onReconnect: () => void;
}): () => void {
  let openedOnce = false;
  let closed = false;
  const eventsUrl = new URL("/api/v1/events", window.location.href);
  eventsUrl.searchParams.set("clientId", options.clientId);
  const source = new EventSource(eventsUrl, { withCredentials: true });
  options.onConnection("connecting");

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
    const parsed = parseEvent(event);
    if (parsed) options.onEvent(parsed);
  };
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      const parsed = parseEvent(event as MessageEvent<string>, type);
      if (parsed) options.onEvent(parsed);
    });
  }

  return () => {
    closed = true;
    source.close();
  };
}
