import { parseActivityFrame } from "../activity/wire.ts";
import type {
  ActivityAppendChannel,
  ActivityFrame,
  ActivityHub,
  ActivityItem,
  ActivityItemDraft,
  Provider,
} from "../activity/index.ts";
import type { NodeBridgeStreamFrame } from "./protocol.ts";

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function asDraft(item: ActivityItem): ActivityItemDraft {
  const {
    schemaVersion: _schemaVersion,
    sessionId: _sessionId,
    provider: _provider,
    seq: _seq,
    revision: _revision,
    ...draft
  } = item;
  return { ...draft, id: item.id, truncated: item.truncated } as ActivityItemDraft;
}

function channelValue(item: ActivityItem, channel: ActivityAppendChannel): string | null {
  if (channel === "text" && (item.kind === "message" || item.kind === "reasoning")) {
    return item.text;
  }
  if (channel === "markdown" && item.kind === "plan") return item.markdown;
  if (channel === "arguments" && item.kind === "tool" && typeof item.arguments === "string") {
    return item.arguments;
  }
  if (channel === "result" && item.kind === "tool" && typeof item.result === "string") {
    return item.result;
  }
  if (channel === "output" && (item.kind === "tool" || item.kind === "subagent")) {
    return item.output;
  }
  if (channel === "details" && item.kind === "lifecycle") return item.details ?? "";
  if (channel === "diff" && item.kind === "file-change") return item.changes.at(-1)?.diff ?? "";
  return null;
}

function appendChannel(
  item: ActivityItem,
  channel: ActivityAppendChannel,
  text: string,
  at: string,
  revision: number,
  truncated: boolean,
): ActivityItem | null {
  let next: ActivityItem | null = null;
  if (channel === "text" && (item.kind === "message" || item.kind === "reasoning")) {
    next = { ...item, text: item.text + text };
  } else if (channel === "markdown" && item.kind === "plan") {
    next = { ...item, markdown: item.markdown + text };
  } else if (channel === "arguments" && item.kind === "tool" && typeof item.arguments === "string") {
    next = { ...item, arguments: item.arguments + text };
  } else if (channel === "result" && item.kind === "tool" && typeof item.result === "string") {
    next = { ...item, result: item.result + text };
  } else if (channel === "output" && (item.kind === "tool" || item.kind === "subagent")) {
    next = { ...item, output: item.output + text };
  } else if (channel === "details" && item.kind === "lifecycle") {
    next = { ...item, details: (item.details ?? "") + text };
  } else if (channel === "diff" && item.kind === "file-change") {
    const changes = [...item.changes];
    const index = changes.length - 1;
    const change = changes[index];
    if (!change) return null;
    changes[index] = { ...change, diff: change.diff + text };
    next = { ...item, changes };
  }
  return next ? { ...next, revision, updatedAt: at, truncated: item.truncated || truncated } : null;
}

/**
 * Validates an untrusted remote activity stream and reprojects it into the
 * local hub. The mirror preserves the remote cursor only for SSE resume; it
 * never claims durable history beyond the remote snapshot's retention window.
 */
export class RemoteActivityMirror {
  readonly #hub: ActivityHub;
  readonly #localSessionId: string;
  readonly #remoteSessionId: string;
  readonly #provider: Provider;
  readonly #items = new Map<string, ActivityItem>();
  #streamEpoch: string | null = null;
  #cursor: string | null = null;
  #sequence: number | null = null;
  #requiresSnapshot = true;

  constructor(options: {
    hub: ActivityHub;
    localSessionId: string;
    remoteSessionId: string;
    provider: Provider;
  }) {
    this.#hub = options.hub;
    this.#localSessionId = options.localSessionId;
    this.#remoteSessionId = options.remoteSessionId;
    this.#provider = options.provider;
    this.#hub.ensureSession(this.#localSessionId, this.#provider);
  }

  get resumeCursor(): string | null {
    return this.#requiresSnapshot ? null : this.#cursor;
  }

  requireSnapshot(): void {
    this.#requiresSnapshot = true;
    this.#cursor = null;
  }

  accept(message: NodeBridgeStreamFrame): void {
    const frame = parseActivityFrame(message.data);
    if (message.eventId !== frame.cursor) throw new Error("Remote activity event id does not match its frame cursor");
    if (frame.sessionId !== this.#remoteSessionId) throw new Error("Remote activity frame belongs to another session");
    if (frame.provider !== this.#provider) throw new Error("Remote activity provider changed");
    if (frame.cursor === this.#cursor) return;

    const initial = this.#streamEpoch === null;
    const epochChanged = !initial && frame.streamEpoch !== this.#streamEpoch;
    const replacement = frame.type === "activity.snapshot" || frame.type === "activity.reset";
    if ((initial || epochChanged || this.#requiresSnapshot) && !replacement) {
      throw new Error("Remote activity stream did not begin with an atomic snapshot");
    }
    if (!epochChanged && this.#sequence !== null && !replacement && frame.seq !== this.#sequence + 1) {
      throw new Error("Remote activity stream has a sequence gap");
    }
    if (!epochChanged && this.#sequence !== null && replacement && frame.seq < this.#sequence) {
      throw new Error("Remote activity stream moved backwards");
    }

    if (frame.type === "activity.snapshot" || frame.type === "activity.reset") {
      const unique = new Map<string, ActivityItem>();
      for (const item of frame.items) {
        this.#validateItem(item, frame);
        if (unique.has(item.id)) throw new Error("Remote activity snapshot contains duplicate item ids");
        unique.set(item.id, item);
      }
      this.#items.clear();
      for (const [id, item] of unique) this.#items.set(id, structuredClone(item));
      this.#hub.ingest(this.#localSessionId, this.#provider, {
        type: "reset",
        reason: frame.type === "activity.reset" ? frame.reason : "provider-reset",
        items: [...this.#items.values()].map((item) => asDraft(item)),
        truncated: frame.truncated,
      });
    } else if (frame.type === "activity.upsert") {
      this.#validateItem(frame.item, frame);
      this.#items.set(frame.item.id, structuredClone(frame.item));
      this.#hub.ingest(this.#localSessionId, this.#provider, {
        type: "upsert",
        item: asDraft(frame.item),
      });
    } else if (frame.type === "activity.remove") {
      this.#items.delete(frame.id);
      this.#hub.ingest(this.#localSessionId, this.#provider, { type: "remove", id: frame.id });
    } else {
      const current = this.#items.get(frame.id);
      if (!current) throw new Error("Remote activity append references an unknown item");
      const currentValue = channelValue(current, frame.channel);
      if (currentValue === null || utf8Bytes(currentValue) !== frame.offset) {
        throw new Error("Remote activity append offset does not match the rendered item");
      }
      if (frame.revision !== current.revision + 1) {
        throw new Error("Remote activity append revision is not monotonic");
      }
      const next = appendChannel(
        current,
        frame.channel,
        frame.text,
        frame.at,
        frame.revision,
        frame.truncated,
      );
      if (!next) throw new Error("Remote activity append channel does not match its item");
      this.#items.set(frame.id, next);
      this.#hub.ingest(this.#localSessionId, this.#provider, {
        type: "upsert",
        item: asDraft(next),
      });
    }

    this.#streamEpoch = frame.streamEpoch;
    this.#sequence = frame.seq;
    this.#cursor = frame.cursor;
    this.#requiresSnapshot = false;
  }

  #validateItem(item: ActivityItem, frame: ActivityFrame): void {
    if (item.sessionId !== this.#remoteSessionId) throw new Error("Remote activity item belongs to another session");
    if (item.provider !== this.#provider) throw new Error("Remote activity item provider changed");
    if (item.seq > frame.seq) throw new Error("Remote activity item sequence is ahead of its frame");
  }
}
