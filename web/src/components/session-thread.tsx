import { useEffect, useMemo, useRef, useState, type ReactNode, type RefCallback } from "react";
import {
  AuiIf,
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useScrollLock,
  useThreadViewportAutoScroll,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Archive, ArrowDown, ChevronDown, LoaderCircle, RefreshCw, RotateCcw, Sparkles, WifiOff } from "lucide-react";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui";
import { DISCLOSURE_SCROLL_LOCK_MS, GroupedActivityParts } from "./thread";
import { MarkdownText } from "./assistant-ui/markdown-text";
import { QueuedMessageCount, SessionComposer, type ComposerDelivery, type ComposerModelOption } from "./composer";
import { TodoList } from "./plans";
import { SessionCapabilityPanel, SessionEndedState } from "./system";
import {
  ActivityRetentionBoundary,
  activityToThreadMessages,
  currentQueue,
  currentTodo,
  exactCurrentActivityRequestIds,
  exactPlanApprovalRequestIds,
  remoteHostLabel,
  renderActivityData,
  todoView,
  type ActivityDataControls,
} from "./session-activity";
import type {
  ActivityItem,
  AttachInstruction,
  ExecutionProfile,
  ReasoningEffort,
  RequestResponse,
  SandboxPolicy,
  SessionActivityView,
  SessionView,
  TakeoverMethod,
} from "../types";
import { toCockpitSessionView } from "../lib/cockpit-view";
import type { PlanFileResponse, SelectedSessionFactsResponse } from "../lib/api";
import { composerEffortOptions } from "../lib/model-catalog";

function UserMessage() {
  return (
    // `rounded-br-[4px]` is the one radius off the named ladder: the bubble's
    // 12px corners are `rounded-bubble`, and the tucked tail that points the
    // bubble at its author is a deliberate 4px, not a scale step.
    <MessagePrimitive.Root className="ml-auto max-w-[86%] rounded-bubble rounded-br-[4px] bg-[var(--surface-selected-hover)] px-4 py-2 text-body-sm text-[var(--text)] sm:max-w-[78%]" data-user-message>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

/*
  `MarkdownText` reads its text from part context rather than props, so the
  part props assistant-ui passes a `Text` component are deliberately dropped.
*/
const SystemMarkdown = () => <MarkdownText />;

/** The projector's own name for what produced this banner, where it named one. */
function systemMessageLabel(message: { metadata?: { custom?: Record<string, unknown> } }): string | null {
  const label = message.metadata?.custom?.["label"];
  return typeof label === "string" && label.length > 0 ? label : null;
}

/*
  A harness banner, or the answer to a slash command the operator typed. This
  rendered as a bare grey slab of `white-space: pre-line` text, which is how
  `/clear` — whose output is markdown, and is the whole point of having asked —
  came out looking like a malfunction. It now reads as a titled panel with the
  same markdown the assistant's own turns get.
*/
function SystemMessage({ label }: { label: string | null }) {
  return (
    <MessagePrimitive.Root
      className="grid min-w-0 gap-1.5 border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-[9px] text-body-sm text-[var(--text-secondary)]"
      aria-label={label ?? "System message"}
      data-system-message
    >
      {label && <h3 className="font-mono text-eyebrow uppercase leading-none tracking-[0.08em] text-[var(--text-faint)]">{label}</h3>}
      <MessagePrimitive.Parts components={{ Text: SystemMarkdown }} />
    </MessagePrimitive.Root>
  );
}

/**
 * Frames 4a/4b and 9a-2 give assistant turns the full drawer width — there is no
 * avatar gutter. The turn's own grammar (tool group, subagent spine, turn marker)
 * carries the authorship, and the reclaimed 36px matters most at 390px.
 */
function AssistantMessage({ controls }: { controls: ActivityDataControls }) {
  return (
    <MessagePrimitive.Root className="grid grid-cols-[minmax(0,1fr)] min-w-0 max-w-full text-body-sm" data-assistant-message>
      <GroupedActivityParts renderData={(name, data) => renderActivityData(name, data, controls)} />
    </MessagePrimitive.Root>
  );
}

export function emptyActivityCopy(
  connection: SessionActivityView["connection"],
  truncated: boolean,
  archived = false,
): { title: string; description: string } {
  // An empty archived drawer is not evidence that no transcript exists until
  // the transport has completed a successful read. Keep transient and terminal
  // connection facts ahead of the archive-empty conclusion.
  if (archived && connection !== "open") {
    switch (connection) {
      case "connecting":
        return { title: "Loading activity", description: "Loading this session's retained history." };
      case "retrying":
        return { title: "Reconnecting to activity", description: "The live stream was interrupted; history is preserved while it reconnects." };
      case "offline":
        return { title: "Activity stream unavailable", description: "The live activity connection could not be opened." };
    }
  }
  if (archived) {
    return {
      title: "No archived activity",
      description: "No retained transcript is available for this archived session.",
    };
  }
  if (truncated) {
    return {
      title: "No retained activity",
      description: "This session's available history begins after the retention boundary.",
    };
  }
  switch (connection) {
    case "connecting":
      return { title: "Loading activity", description: "Loading this session's retained history." };
    case "retrying":
      return { title: "Reconnecting to activity", description: "The live stream was interrupted; history is preserved while it reconnects." };
    case "offline":
      return { title: "Activity stream unavailable", description: "The live activity connection could not be opened." };
    case "open":
      return { title: "Waiting for provider activity", description: "Only events the provider exposes will appear here." };
  }
}

function EmptyActivity({ connection, truncated, archived }: { connection: SessionActivityView["connection"]; truncated: boolean; archived: boolean }) {
  const copy = emptyActivityCopy(connection, truncated, archived);
  return (
    <section className="grid min-h-56 place-content-center gap-3 text-center text-[var(--text-muted)]">
      {connection === "connecting" || connection === "retrying"
        ? <LoaderCircle size={20} className="mx-auto motion-safe:animate-spin" />
        : connection === "offline"
        ? <WifiOff size={20} className="mx-auto" />
        : archived
        ? <Archive size={20} className="mx-auto" />
        : <Sparkles size={20} className="mx-auto" />}
      <div><h3 className="text-title-sm text-[var(--text)]">{copy.title}</h3><p className="mt-1 text-meta-sm">{copy.description}</p></div>
    </section>
  );
}

function ActivityConnectionBanner({ connection, onRetry }: {
  connection: SessionActivityView["connection"];
  onRetry?: () => void;
}) {
  if (connection === "open") return null;
  const copy = emptyActivityCopy(connection, false);
  const terminal = connection === "offline";
  return (
    <section className="flex items-start gap-2 border-l-2 border-[var(--warning)] bg-[var(--warning-field)] px-3 py-2.5 text-code-sm text-[var(--text-muted)]" role="status" data-activity-connection>
      {terminal
        ? <WifiOff size={14} className="mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
        : <LoaderCircle size={14} className="mt-0.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />}
      <div className="min-w-0 flex-1"><strong className="text-[var(--text-secondary)]">{copy.title}.</strong> {copy.description}</div>
      {terminal && onRetry && <Button variant="ghost" size="sm" data-compact-control className="shrink-0 gap-1 underline underline-offset-2" onClick={onRetry}><RefreshCw size={12} aria-hidden="true" />Retry activity</Button>}
    </section>
  );
}

/*
  This panel sits above the whole transcript, so collapsing it used to shove
  every turn below it upward. It is now the same Radix Collapsible the rest of
  the cockpit uses — which also gives the trigger the `aria-expanded` and
  `aria-controls` a bare `<summary>` never had — and it joins the thread's
  scroll lock so the toggle no longer moves what the operator is reading.
*/
function SessionDetails({ session, remote, facts, factsStatus, attachInstruction, attachError, loadingAttach, onRevealAttach }: { session: SessionView; remote: boolean; facts: SelectedSessionFactsResponse | null; factsStatus: "loading" | "loaded" | "error"; attachInstruction: AttachInstruction | null; attachError: string | null; loadingAttach: boolean; onRevealAttach: () => void }) {
  const view = toCockpitSessionView(session, { remote });
  const attachCommand = attachInstruction?.available ? attachInstruction.command : null;
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(panelRef, DISCLOSURE_SCROLL_LOCK_MS);
  return (
    <Collapsible ref={panelRef} open={open} onOpenChange={(next) => { lockScroll(); setOpen(next); }} className="border border-[var(--border)] bg-[var(--surface-raised)]">
      <CollapsibleTrigger data-compact-control className="flex min-h-10 w-full cursor-pointer items-center px-3 text-meta-sm font-medium">Session facts and capabilities</CollapsibleTrigger>
      <CollapsibleContent>
        {/* minmax(0,1fr): an implicit `auto` track sizes to max-content, which let
            long mono fact values push the panel past a 390px viewport and get clipped. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 border-t border-[var(--rule)] p-3">
          <SessionCapabilityPanel
            session={view}
            archived={session.archived}
            facts={facts}
            factsStatus={factsStatus}
            attachCommand={attachCommand}
            attachDescription={attachInstruction?.description ?? null}
            attachRequiresHandoff={attachInstruction?.requiresHandoff ?? false}
            attachError={attachError}
            loadingAttach={loadingAttach}
            onRevealAttach={onRevealAttach}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Owns the thread runtime for whatever surface the drawer is showing, and hands
 * that surface a ref for its own scroll container.
 *
 * The runtime has to sit *above* the drawer. The only scroller in the drawer is
 * `[data-thread-content]`, which the drawer itself renders; a viewport created
 * inside `SessionThread` would nest a second scroller inside that one and
 * reintroduce the chaining the drawer avoids. Hoisting it also puts the
 * composer — passed to the drawer as a sibling prop — inside the runtime for
 * the first time.
 *
 * `AssistantRuntimeProvider` already supplies a thread viewport store and
 * neither provider renders an element, so the drawer stays a direct child of
 * `[data-board-region]`.
 */
export interface SessionQueueControls {
  /** The harness's queue, as the provider reported it. */
  messages: readonly { id: string; text: string; status: string }[];
  canRemove: boolean;
  onRemove: (messageId: string) => void;
}

export function SessionRuntimeProvider({
  items,
  queue,
  children,
}: {
  items: readonly ActivityItem[];
  queue?: SessionQueueControls;
  children: (viewportRef: RefCallback<HTMLDivElement>) => ReactNode;
}) {
  const messages = useMemo(() => activityToThreadMessages(items), [items]);
  /*
    `createMessageQueue` builds a queue the *runtime* owns. This cockpit's queue
    belongs to the harness — it arrives as `kind:"queue"` activity items — so
    the adapter reads from those and never holds a message of its own. What the
    primitives get is provider truth; what they can do to it is whatever the
    capability list actually offers.
  */
  const queueMessages = queue?.messages;
  const queueAdapter = useMemo(() => (queueMessages === undefined ? undefined : {
    items: queueMessages.map((message) => ({ id: message.id, prompt: message.text })),
    // Sending is gated in `useCockpit.sendMessage`, and every send in this
    // cockpit goes through it. Routing an enqueue around that would hand the
    // composer a delivery the harness never advertised.
    enqueue: () => undefined,
    steer: () => undefined,
    remove: (id: string) => { if (queue?.canRemove) queue.onRemove(id); },
    clear: () => undefined,
  }), [queue, queueMessages]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    // Per-item status is authoritative. The runtime must not invent an empty
    // assistant message merely because the provider has an active turn.
    isRunning: false,
    isDisabled: true,
    onNew: async () => undefined,
    ...(queueAdapter ? { queue: queueAdapter } : {}),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadViewportBridge>{children}</ThreadViewportBridge>
    </AssistantRuntimeProvider>
  );
}

function ThreadViewportBridge({ children }: { children: (viewportRef: RefCallback<HTMLDivElement>) => ReactNode }) {
  /*
    `scrollToBottomOnRunStart` is deliberately absent: `isRunning` is pinned to
    false above, so it could never fire. New activity is what moves the view,
    and `autoScroll` only follows while the operator is already at the bottom —
    scrolling up detaches, returning re-attaches.
  */
  const viewportRef = useThreadViewportAutoScroll<HTMLDivElement>({
    autoScroll: true,
    scrollToBottomOnInitialize: true,
    scrollToBottomOnThreadSwitch: true,
  });
  return <>{children(viewportRef)}</>;
}

export function SessionThread({
  session,
  activity,
  remote,
  busy,
  mutationsReady,
  onRespond,
  onRemoveQueued,
  onOpenEditor,
  onResumeInWeb,
  readKeys,
  onReadChange,
  loadAttach,
  loadSessionFacts,
  loadPlanFile,
  onContinueInWorkspace,
  onRetryActivity,
  sessionsOnHost,
}: {
  session: SessionView;
  activity: SessionActivityView;
  remote: boolean;
  busy: boolean;
  mutationsReady: boolean;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
  onRemoveQueued: (messageId: string) => Promise<void>;
  onOpenEditor: (relativePath: string) => Promise<void>;
  onResumeInWeb: () => Promise<void>;
  readKeys: ReadonlySet<string>;
  onReadChange: (readKey: string, read: boolean) => void;
  loadAttach: () => Promise<AttachInstruction>;
  loadSessionFacts: (sessionId: string, generation: number) => Promise<SelectedSessionFactsResponse>;
  loadPlanFile: (itemId: string) => Promise<PlanFileResponse>;
  onContinueInWorkspace: () => void;
  onRetryActivity?: () => void;
  sessionsOnHost: number | null;
}) {
  const [attachInstruction, setAttachInstruction] = useState<AttachInstruction | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [loadingAttach, setLoadingAttach] = useState(false);
  const attachRequestRef = useRef(0);
  const attachControlKey = [
    session.generation,
    session.control.plane,
    session.control.authority,
    session.control.coordination?.mode ?? "unknown",
    session.control.coordination?.nativeAttach ?? "unknown",
    session.control.takeover?.id ?? "none",
    session.control.takeover?.state ?? "none",
  ].join("\u0000");
  const attachControlKeyRef = useRef(attachControlKey);
  attachControlKeyRef.current = attachControlKey;
  const [facts, setFacts] = useState<SelectedSessionFactsResponse | null>(null);
  const [factsStatus, setFactsStatus] = useState<"loading" | "loaded" | "error">("loading");
  const exactRequestIds = useMemo(() => exactCurrentActivityRequestIds(activity.items), [activity.items]);
  const planApprovalRequestIds = useMemo(() => exactPlanApprovalRequestIds(activity.items, exactRequestIds), [activity.items, exactRequestIds]);
  // Exactly the requests a plan artifact offers controls for. A plan that
  // cannot offer them — truncated or superseded — keeps its approval card, so
  // the operator is never left without a way to answer.
  const planOwnedRequestIds = useMemo(() => new Set(planApprovalRequestIds.values()), [planApprovalRequestIds]);
  useEffect(() => {
    let cancelled = false;
    setFacts(null);
    setFactsStatus("loading");
    void loadSessionFacts(session.id, session.generation).then((response) => {
      if (!cancelled) { setFacts(response); setFactsStatus("loaded"); }
    }).catch(() => {
      if (!cancelled) { setFacts(null); setFactsStatus("error"); }
    });
    return () => { cancelled = true; };
  }, [loadSessionFacts, session.generation, session.id]);
  useEffect(() => {
    setAttachInstruction(null);
    setAttachError(null);
    setLoadingAttach(false);
    attachRequestRef.current += 1;
  }, [attachControlKey]);
  async function revealAttach() {
    const request = ++attachRequestRef.current;
    const controlKey = attachControlKeyRef.current;
    setLoadingAttach(true);
    setAttachError(null);
    try {
      const instruction = await loadAttach();
      if (attachRequestRef.current !== request || attachControlKeyRef.current !== controlKey) return;
      setAttachInstruction(instruction);
      if (!instruction.available) setAttachError("This harness did not return a guarded resume or attach wrapper.");
    } catch (error) {
      if (attachRequestRef.current !== request) return;
      setAttachError(error instanceof Error ? error.message : "Attach details are unavailable.");
    } finally {
      if (attachRequestRef.current === request) setLoadingAttach(false);
    }
  }
  const controls: ActivityDataControls = {
    attention: {
      exactRequestIds,
      planOwnedRequestIds,
      mutationsReady,
      canRespond: session.control.capabilities.includes("respond"),
      busy,
      workspaceRoot: session.workspaceIdentity?.worktreePath ?? session.cwd,
      remoteHost: remoteHostLabel(session, remote),
      sessionsOnHost,
      onRespond,
    },
    files: {
      sessionId: session.id,
      canOpenEditor: session.control.capabilities.includes("open-editor"),
      workspaceRoot: session.workspaceIdentity?.worktreePath ?? session.cwd,
      readKeys,
      onReadChange,
      onOpenEditor: (path) => void onOpenEditor(path),
    },
    plans: {
      requestIds: planApprovalRequestIds,
      mutationsReady,
      canRespond: session.control.capabilities.includes("respond"),
      busy,
      loadFile: loadPlanFile,
      onRespond,
    },
    queue: {
      canRemove: mutationsReady && session.control.capabilities.includes("remove-queued"),
      busy,
      withheldReason: session.control.capabilities.includes("remove-queued")
        ? null
        : session.control.withheld.find((item) => item.capability === "remove-queued")?.reason
          ?? "This harness does not expose removing a queued message.",
    },
  };
  return (
    <ThreadPrimitive.Root>
      {/* Drawer body: 20px between turn parts (spec 05 R7, frame 4a). */}
      <div className="flex min-w-0 flex-col gap-5" role="log" aria-label="Provider activity" aria-live="polite" aria-relevant="additions text">
        <SessionDetails session={session} remote={remote} facts={facts} factsStatus={factsStatus} attachInstruction={attachInstruction} attachError={attachError} loadingAttach={loadingAttach} onRevealAttach={() => void revealAttach()} />
        {session.archived && <section className="flex items-center gap-2 border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-meta-sm text-[var(--text-muted)]" role="status" data-archived-read-only><Archive size={14} aria-hidden="true" /><strong className="text-[var(--text-secondary)]">Archived · read-only</strong><span>History and facts remain available; archived sessions cannot be changed.</span></section>}
        {activity.items.length > 0 && <ActivityConnectionBanner connection={activity.connection} {...(onRetryActivity ? { onRetry: onRetryActivity } : {})} />}
        {activity.truncated && <ActivityRetentionBoundary />}
        <AuiIf condition={(state) => state.thread.isEmpty}><EmptyActivity connection={activity.connection} truncated={activity.truncated} archived={session.archived} /></AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) => message.role === "user" ? <UserMessage /> : message.role === "system" ? <SystemMessage label={systemMessageLabel(message)} /> : <AssistantMessage controls={controls} />}
        </ThreadPrimitive.Messages>
        {!session.archived && ["completed", "failed", "interrupted"].includes(session.status) && <div><SessionEndedState canResume={session.control.capabilities.includes("resume")} resumeUnavailableReason={session.control.withheld.find(({ capability }) => capability === "resume")?.reason ?? null} resuming={busy} resumeDisabled={!mutationsReady} onResume={() => void onResumeInWeb().catch(() => undefined)} canContinue={Boolean(session.workspaceIdentity?.worktreePath ?? session.cwd)} onContinue={onContinueInWorkspace} /></div>}
        {/*
          Auto-scroll detaches the moment the operator scrolls up, so a long
          turn needs a way back. The primitive renders nothing while the view is
          already at the bottom.
        */}
        <ThreadPrimitive.ScrollToBottom asChild>
          <Button
            variant="secondary"
            size="sm"
            data-compact-control="height"
            data-scroll-to-latest
            className="sticky bottom-2 z-10 place-self-center rounded-full border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 shadow-[var(--shadow-drawer)] disabled:hidden"
          >
            <ArrowDown size={13} strokeWidth={2} aria-hidden="true" />Jump to latest
          </Button>
        </ThreadPrimitive.ScrollToBottom>
      </div>
    </ThreadPrimitive.Root>
  );
}

const PROFILES: readonly ExecutionProfile[] = ["ask-first", "plan", "execute", "full-access"];

export function relativeDeadlineCopy(deadlineAt: string | null, now = Date.now()): string | null {
  if (!deadlineAt) return null;
  const remaining = Date.parse(deadlineAt) - now;
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "deadline reached";
  const seconds = Math.ceil(remaining / 1_000);
  if (seconds < 60) return `${seconds}s remaining`;
  const minutes = Math.floor(seconds / 60);
  const trailingSeconds = seconds % 60;
  return `${minutes}m${trailingSeconds ? ` ${trailingSeconds}s` : ""} remaining`;
}

function useRelativeDeadline(deadlineAt: string | null): string | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!deadlineAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [deadlineAt]);
  return relativeDeadlineCopy(deadlineAt, now);
}

function providerLabel(session: SessionView): string {
  return session.provider === "claude" ? "Claude Code" : "Codex";
}

export function SessionThreadComposer({
  session,
  activity,
  busy,
  mutationsReady,
  onSend,
  onInterrupt,
  onSetProfile,
  onSetSandbox,
  onSetModel,
  onSetEffort,
  modelOptions,
  modelOptionsStatus,
  effortOptions,
  restoredDraft,
  onOpenSetup,
  onTakeControl,
  onCancelTakeControl,
  onRetryControl,
  onResumeInWeb,
  onSearchFiles,
}: {
  session: SessionView;
  activity: SessionActivityView;
  busy: boolean;
  mutationsReady: boolean;
  onSend: (text: string, delivery: "queue" | "steer") => Promise<void>;
  onInterrupt: () => Promise<void>;
  onSetProfile: (profile: ExecutionProfile) => Promise<void>;
  onSetSandbox: (sandbox: SandboxPolicy) => Promise<void>;
  onSetModel: (model: string) => Promise<void>;
  onSetEffort: (effort: ReasoningEffort) => Promise<void>;
  modelOptions: readonly ComposerModelOption[];
  modelOptionsStatus: string | null;
  effortOptions?: readonly ReasoningEffort[];
  restoredDraft?: { key: string; text: string } | null;
  onOpenSetup?: () => void;
  onTakeControl?: (method: TakeoverMethod, takeoverId?: string) => Promise<void>;
  onCancelTakeControl?: (takeoverId: string) => Promise<void>;
  onRetryControl?: () => Promise<void>;
  onResumeInWeb?: () => Promise<void>;
  /** Absent where the workspace is not readable from here, e.g. a remote host. */
  onSearchFiles?: (query: string) => Promise<readonly string[]>;
}) {
  const [text, setText] = useState("");
  const [takeoverMenuOpen, setTakeoverMenuOpen] = useState(false);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  useEffect(() => {
    if (restoredDraft) setText(restoredDraft.text);
  }, [restoredDraft]);
  useEffect(() => {
    setTakeoverMenuOpen(false);
    setTakeoverBusy(false);
    setTakeoverError(null);
    setRecoveryBusy(false);
    setRecoveryError(null);
    setResumeBusy(false);
    setResumeError(null);
  }, [session.id]);
  const queued = currentQueue(activity);
  const todo = currentTodo(activity);
  const canQueue = session.control.capabilities.includes("queue");
  const canSteer = session.control.capabilities.includes("steer");
  const canStop = session.control.capabilities.includes("interrupt");
  const canSetProfile = session.control.capabilities.includes("set-profile");
  const canSetSandbox = session.control.capabilities.includes("set-sandbox");
  const canSetModel = session.control.capabilities.includes("set-model");
  const canSetEffort = session.control.capabilities.includes("set-effort");
  const active = session.status === "running" || session.status === "waiting";
  async function send(delivery: ComposerDelivery) {
    const message = text.trim();
    if (!message) return;
    await onSend(message, delivery);
    setText("");
  }
  const noWriteReason = !canQueue && !canSteer
    ? session.control.withheld.find((item) => item.capability === "queue")?.reason ?? "Replies are unavailable."
    : null;
  const takeover = session.control.takeover;
  const recovery = session.control.recovery;
  const waitingForNativeExit = recovery?.state === "waiting-for-native-exit";
  const deadlineCopy = useRelativeDeadline(recovery
    ? (waitingForNativeExit ? null : recovery.state === "retrying" ? recovery.nextRetryAt : recovery.deadlineAt)
    : takeover?.deadlineAt ?? null);
  const sharedCodex = session.provider === "codex" && session.control.coordination.mode === "shared";
  const managedSharedCodex = sharedCodex
    && session.control.authority === "manager"
    && (canQueue || canSteer);
  const canTakeControl = session.control.capabilities.includes("take-control")
    && takeover !== null
    && takeover.methods.length > 0
    && (takeover.state === "available" || takeover.state === "failed")
    && onTakeControl !== undefined;
  const canCancelTakeover = session.control.capabilities.includes("cancel-take-control")
    && (takeover?.state === "waiting-for-exit" || takeover?.state === "awaiting-confirmation")
    && takeover.id !== null
    && onCancelTakeControl !== undefined;
  const canConfirmGraceful = session.control.capabilities.includes("take-control")
    && takeover?.state === "awaiting-confirmation"
    && takeover.method === "graceful-stop"
    && takeover.id !== null
    && onTakeControl !== undefined;
  const canEscalateGuided = session.control.capabilities.includes("take-control")
    && takeover?.state === "waiting-for-exit"
    && takeover.method === "guided-exit"
    && takeover.methods.includes("graceful-stop")
    && takeover.id !== null
    && onTakeControl !== undefined;
  const activeTakeover = takeover !== null
    && (takeover.state === "awaiting-confirmation"
      || takeover.state === "waiting-for-exit"
      || takeover.state === "stopping"
      || takeover.state === "adopting");
  // A discovered standalone Codex process describes its *current* surface as
  // observe-only. The target of takeover is nevertheless the manager-owned,
  // multi-client Codex server, so migration copy must follow the provider and
  // offered action rather than misreading current coordination as exclusive.
  const codexSharedTarget = managedSharedCodex
    || (session.provider === "codex"
      && session.control.authority === "foreign"
      && (canTakeControl || activeTakeover || takeover?.state === "failed"));
  const hookSetupMissing = onOpenSetup !== undefined && (
    session.control.plane === "observe-only"
    || session.control.withheld.some((item) => /hook (?:bridge|setup)/iu.test(item.reason))
  );
  const sessionEnded = ["completed", "failed", "interrupted"].includes(session.status);
  const canResumeHere = !sessionEnded
    && !canQueue
    && !canSteer
    && session.control.capabilities.includes("resume")
    && !activeTakeover
    && (!session.control.capabilities.includes("take-control") || takeover?.state === "failed")
    && onResumeInWeb !== undefined;
  const canRetryControl = session.control.capabilities.includes("retry-control")
    && recovery !== null
    && !waitingForNativeExit
    && onRetryControl !== undefined;
  const canShowTakeControl = canTakeControl && (!recovery || waitingForNativeExit);
  async function beginTakeover(method: TakeoverMethod, takeoverId?: string) {
    if (!onTakeControl) return;
    setTakeoverBusy(true);
    setTakeoverError(null);
    try {
      await onTakeControl(method, takeoverId);
      setTakeoverMenuOpen(false);
    } catch (error) {
      setTakeoverError(error instanceof Error ? error.message : "Control migration could not start.");
    } finally {
      setTakeoverBusy(false);
    }
  }
  async function cancelTakeover() {
    if (!canCancelTakeover || !takeover?.id || !onCancelTakeControl) return;
    setTakeoverBusy(true);
    setTakeoverError(null);
    try {
      await onCancelTakeControl(takeover.id);
    } catch (error) {
      setTakeoverError(error instanceof Error ? error.message : "Control migration could not be cancelled.");
    } finally {
      setTakeoverBusy(false);
    }
  }
  async function retryControl() {
    if (!canRetryControl || !onRetryControl) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      await onRetryControl();
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "Control recovery could not restart.");
    } finally {
      setRecoveryBusy(false);
    }
  }
  async function resumeHere() {
    if (!canResumeHere || !onResumeInWeb) return;
    setResumeBusy(true);
    setResumeError(null);
    try {
      await onResumeInWeb();
    } catch (error) {
      setResumeError(error instanceof Error ? error.message : "This exact session could not resume in the web app.");
    } finally {
      setResumeBusy(false);
    }
  }
  /*
    Every published view rules on every capability, so a withheld entry is
    always there to read. The fallback exists only so a hole cannot render an
    empty tooltip — it deliberately claims nothing about the harness, because
    the fabricated "this harness does not expose it" is precisely what told
    operators to go looking for a setting that was never missing.
  */
  const unavailableReason = (capability: "set-model" | "set-effort" | "set-profile" | "set-sandbox") =>
    session.control.withheld.find((item) => item.capability === capability)?.reason
      ?? "This control is unavailable for this session.";
  const effortChoices = composerEffortOptions(session.provider, effortOptions, canSetEffort);
  const takeoverFailed = takeover?.state === "failed";
  const showControlStatus = Boolean(noWriteReason || recovery || canTakeControl || canResumeHere || takeoverFailed || resumeError);
  const routineControlStatus = !recovery && !takeoverFailed && !resumeError && canResumeHere;
  const statusTitle = recovery
    ? recovery.state === "waiting-for-native-exit"
      ? "Claude Code has control"
      : recovery.state === "reconnecting"
      ? `Reconnecting ${providerLabel(session)} control`
      : recovery.state === "retrying"
        ? `${providerLabel(session)} control will retry`
        : `${providerLabel(session)} control needs attention`
    : takeoverFailed
      ? "Web control was not connected"
    : canResumeHere
      ? "Ready to resume here"
      : session.provider === "codex" && session.control.authority === "foreign"
        ? "Codex CLI is running"
      : session.provider === "claude" && session.control.authority === "foreign"
          ? "Claude Code has control"
          : hookSetupMissing
            ? "Live observation only"
            : "Messages unavailable";
  const statusDetail = recovery
    ? recovery.state === "waiting-for-native-exit"
      ? canShowTakeControl
        ? "Web control reconnects automatically after this exact CLI exits, or you can transfer it safely here. History and exact live activity remain available."
        : "Web control reconnects automatically after this exact CLI exits. History and exact live activity remain available here."
      : recovery.state === "needs-attention"
      ? "Agent Manager could not restore web control. Your conversation history is safe."
      : recovery.state === "retrying"
        ? "History remains available while Agent Manager waits for the next automatic attempt."
        : "History remains available while Agent Manager restores exact provider control."
    : takeoverFailed
      ? "The conversation history is preserved. Retry the provider-specific migration here; optional CLI access remains under Advanced session facts."
    : canResumeHere
      ? "Continue this exact provider conversation in Agent Manager. No terminal command is required."
      : noWriteReason;
  return (
    <div className="grid min-w-0 max-w-full gap-3" data-session-thread-composer>
      {todo && <TodoList list={todoView(todo, session.todoProgress)} canMessage={canQueue} canStop={canStop && mutationsReady} onAsk={() => setText("What is happening with the current todo?")} onStop={() => void onInterrupt()} />}
      <QueuedMessageCount count={queued.length} />
      {showControlStatus && (
        <Collapsible
          key={`${session.id}:${statusTitle}:${routineControlStatus ? "routine" : "active"}`}
          defaultOpen={!routineControlStatus}
          className="grid gap-1.5 px-0.5 text-code-xs text-[var(--text-muted)]"
          role="status"
          data-control-state
          data-routine-control-state={routineControlStatus ? "true" : "false"}
        >
          <div className="flex min-h-7 flex-wrap items-center gap-1.5">
            {statusDetail ? (
              <CollapsibleTrigger
                data-compact-control="height"
                data-control-detail-trigger
                className="group inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 text-left font-medium text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-selected)] hover:text-[var(--text-secondary)] data-[state=open]:text-[var(--text-secondary)]"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true" />
                <span className="truncate">{statusTitle}</span>
                <ChevronDown size={11} className="shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
              </CollapsibleTrigger>
            ) : (
              <strong className="font-medium text-[var(--text-secondary)]">{statusTitle}</strong>
            )}
            {recovery && recovery.state !== "needs-attention" && recovery.state !== "waiting-for-native-exit" && <span aria-hidden="true">·</span>}
            {recovery && recovery.state !== "needs-attention" && recovery.state !== "waiting-for-native-exit" && <span>attempt {recovery.attempt}</span>}
            {deadlineCopy && <><span aria-hidden="true">·</span><span>{deadlineCopy}</span></>}
            {canRetryControl && <><span aria-hidden="true">·</span><button type="button" data-compact-control="height" className="underline underline-offset-2" disabled={!mutationsReady || recoveryBusy} onClick={() => void retryControl()}>{recoveryBusy ? "Retrying web control…" : "Retry web control"}</button></>}
            {canResumeHere && <Button variant="primary" size="sm" data-compact-control disabled={!mutationsReady || busy || resumeBusy} onClick={() => void resumeHere()}><RotateCcw size={12} aria-hidden="true" />{resumeBusy ? "Resuming…" : "Resume here"}</Button>}
            {hookSetupMissing && !recovery && <><span aria-hidden="true">·</span><button type="button" data-read-only-explainer data-compact-control="height" className="underline underline-offset-2" onClick={onOpenSetup}>Enable live activity</button></>}
            {canShowTakeControl && <><span aria-hidden="true">·</span><button type="button" data-compact-control="height" className="underline underline-offset-2" disabled={!mutationsReady || busy || takeoverBusy} onClick={() => setTakeoverMenuOpen((open) => !open)}>{takeoverFailed ? (codexSharedTarget ? "Retry shared-control migration" : "Retry moving Claude control") : codexSharedTarget ? "Migrate to shared web + CLI" : "Move Claude Code control here"}</button></>}
          </div>
          {statusDetail && (
            <CollapsibleContent className="grid gap-1.5 pl-3 text-[var(--text-muted)]" data-control-detail-content>
              <p data-control-detail>{statusDetail}</p>
              {recovery?.state === "retrying" && recovery.nextRetryAt && <p>Agent Manager will retry automatically; the transcript remains available now.</p>}
              {recovery?.error && !waitingForNativeExit && <Collapsible><CollapsibleTrigger data-compact-control className="cursor-pointer underline underline-offset-2">Technical details</CollapsibleTrigger><CollapsibleContent><pre className="mt-1 whitespace-pre-wrap break-words bg-[var(--surface-raised)] p-2 font-mono text-code-xs text-[var(--text-muted)]" data-recovery-technical-details>{recovery.error}</pre></CollapsibleContent></Collapsible>}
            </CollapsibleContent>
          )}
          {recoveryError && <p className="text-[var(--warning)]" data-recovery-error>{recoveryError}</p>}
          {resumeError && <p className="text-[var(--warning)]" data-resume-error>{resumeError}</p>}

          {takeover?.state === "waiting-for-exit" && (
            <div className="flex flex-wrap items-center gap-2" data-takeover-state>
              <span>{codexSharedTarget
                ? "Agent Manager is waiting for exclusive access to migrate this exact conversation. Stop the validated Codex process safely here, or keep waiting."
                : "Agent Manager is waiting for exclusive access to this exact conversation. Stop the validated Claude Code process safely here, or keep waiting."}</span>
              {canEscalateGuided && <Button variant="primary" size="sm" data-compact-control disabled={!mutationsReady || takeoverBusy} onClick={() => void beginTakeover("graceful-stop", takeover.id ?? undefined)}>{takeoverBusy ? "Revalidating…" : "Stop safely here…"}</Button>}
              {canCancelTakeover && <Button variant="secondary" size="sm" data-compact-control disabled={takeoverBusy} onClick={() => void cancelTakeover()}>Cancel</Button>}
            </div>
          )}
          {takeover?.state === "awaiting-confirmation" && takeover.id && (
            <div className="grid gap-2 border border-[var(--border)] bg-[var(--surface-raised)] p-3" data-takeover-confirmation>
              <p>Agent Manager pinned the exact {providerLabel(session)} process. No signal has been sent.</p>
              <p>Confirm one identity-revalidated SIGTERM. Agent Manager then waits 15 seconds and never sends SIGKILL or a second signal.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" disabled={!mutationsReady || takeoverBusy || !canConfirmGraceful} onClick={() => void beginTakeover("graceful-stop", takeover.id ?? undefined)}>{takeoverBusy ? "Confirming…" : codexSharedTarget ? "Confirm stop and migrate" : "Confirm graceful stop"}</Button>
                {canCancelTakeover && <Button variant="ghost" size="sm" disabled={takeoverBusy} onClick={() => void cancelTakeover()}>Cancel without signalling</Button>}
              </div>
            </div>
          )}
          {takeover?.state === "stopping" && <p data-takeover-state>Waiting for the validated {providerLabel(session)} process to stop gracefully…</p>}
          {takeover?.state === "adopting" && <p data-takeover-state>{codexSharedTarget ? "Migrating the exact Codex conversation onto shared CLI + web control…" : "Connecting the exact Claude conversation to Agent Manager…"}</p>}
          {takeover?.state === "failed" && takeover.error && (
            <p className="text-[var(--warning)]" data-takeover-error>
              {takeover.error}
              {canTakeControl ? (codexSharedTarget ? " Retry the shared-control migration." : " Retry moving Claude control.") : ""}
              {(session.control.capabilities.includes("attach") || session.control.capabilities.includes("resume")) ? " Optional CLI access is available under Advanced session facts." : ""}
            </p>
          )}
          {takeoverError && <p className="text-[var(--warning)]" data-takeover-error>{takeoverError}</p>}
          {takeoverMenuOpen && canTakeControl && (
            <div className="grid gap-2 border border-[var(--border)] bg-[var(--surface-raised)] p-3" data-takeover-menu>
              <p>{codexSharedTarget
                ? "This is a one-time migration onto Agent Manager's Codex server. After it completes, Codex CLI and web remain writable together."
                : "Claude Code supports one writer. Agent Manager becomes writable only after Claude Code exits and the same conversation is confirmed."}</p>
              {takeover.fallbackProfile && <p className="text-[var(--warning)]">The current profile was not exposed. Web control will start in <strong>{takeover.fallbackProfile}</strong>; you can change it immediately after connection.</p>}
              {takeover.fallbackSandbox && <p className="text-[var(--warning)]">The current sandbox was not exposed. Web control will contain this session to its workspace without network access; you can change it immediately after connection.</p>}
              <div className="flex flex-wrap gap-2">
                {takeover.methods.includes("graceful-stop") && <Button variant="primary" size="sm" disabled={!mutationsReady || takeoverBusy} onClick={() => void beginTakeover("graceful-stop")}>{takeoverBusy ? "Pinning exact process…" : codexSharedTarget ? "Prepare graceful Codex stop…" : "Prepare graceful Claude Code stop…"}</Button>}
                {takeover.methods.includes("guided-exit") && <Button variant="secondary" size="sm" disabled={!mutationsReady || takeoverBusy} onClick={() => void beginTakeover("guided-exit")}>{takeoverBusy ? "Starting…" : codexSharedTarget ? "I’ll exit Codex myself" : "I’ll exit Claude Code myself"}</Button>}
              </div>
            </div>
          )}
        </Collapsible>
      )}
      {!mutationsReady && (canQueue || canSteer) && <p className="text-center font-mono text-code-xs text-[var(--warning)]">Offline drafts stay on this device and are sent only if the session state is unchanged.</p>}
      <SessionComposer
        value={text}
        onChange={setText}
        onSend={send}
        onStop={onInterrupt}
        isRunning={active}
        canQueue={canQueue}
        canSteer={canSteer}
        canStop={canStop && mutationsReady}
        readOnlyReason={noWriteReason}
        provider={session.provider}
        model={session.model.value}
        effort={session.effort.value}
        profile={session.profile.value}
        sandbox={session.sandbox.value}
        modelOptions={modelOptions}
        modelOptionsStatus={modelOptionsStatus}
        modelChangeUnavailableReason={canSetModel ? null : unavailableReason("set-model")}
        effortChangeUnavailableReason={canSetEffort ? null : unavailableReason("set-effort")}
        profileChangeUnavailableReason={canSetProfile ? null : unavailableReason("set-profile")}
        sandboxChangeUnavailableReason={canSetSandbox ? null : unavailableReason("set-sandbox")}
        effortOptions={effortChoices}
        profileOptions={canSetProfile ? PROFILES : session.profile.value ? [session.profile.value] : []}
        busy={busy}
        {...(canShowTakeControl && takeover?.methods[0]
          ? { onTakeControl: () => { void beginTakeover(takeover.methods[0]!); } }
          : {})}
        {...(canSetModel ? { onModelChange: (model: string) => void onSetModel(model) } : {})}
        {...(canSetEffort ? { onEffortChange: (effort: ReasoningEffort) => void onSetEffort(effort) } : {})}
        {...(canSetProfile ? { onProfileChange: (profile: ExecutionProfile) => void onSetProfile(profile) } : {})}
        {...(canSetSandbox ? { onSandboxChange: (sandbox: SandboxPolicy) => void onSetSandbox(sandbox) } : {})}
        {...(onSearchFiles ? { onSearchFiles } : {})}
      />
    </div>
  );
}
