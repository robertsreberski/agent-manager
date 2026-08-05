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
import { ArrowDown, Copy, LoaderCircle, Sparkles } from "lucide-react";
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
  SessionActivityView,
  SessionView,
  TakeoverMethod,
} from "../types";
import { toCockpitSessionView } from "../lib/cockpit-view";
import type { PlanFileResponse, SelectedSessionFactsResponse } from "../lib/api";

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
): { title: string; description: string } {
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

function EmptyActivity({ connection, truncated }: { connection: SessionActivityView["connection"]; truncated: boolean }) {
  const copy = emptyActivityCopy(connection, truncated);
  return (
    <section className="grid min-h-56 place-content-center gap-3 text-center text-[var(--text-muted)]">
      {connection === "connecting" || connection === "retrying"
        ? <LoaderCircle size={20} className="mx-auto motion-safe:animate-spin" />
        : <Sparkles size={20} className="mx-auto" />}
      <div><h3 className="text-title-sm text-[var(--text)]">{copy.title}</h3><p className="mt-1 text-meta-sm">{copy.description}</p></div>
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
          <SessionCapabilityPanel session={view} facts={facts} factsStatus={factsStatus} attachCommand={attachCommand} attachError={attachError} loadingAttach={loadingAttach} onRevealAttach={onRevealAttach} />
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
  readKeys,
  onReadChange,
  loadAttach,
  loadSessionFacts,
  loadPlanFile,
  onContinueInWorkspace,
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
  readKeys: ReadonlySet<string>;
  onReadChange: (readKey: string, read: boolean) => void;
  loadAttach: () => Promise<AttachInstruction>;
  loadSessionFacts: (sessionId: string, generation: number) => Promise<SelectedSessionFactsResponse>;
  loadPlanFile: (itemId: string) => Promise<PlanFileResponse>;
  onContinueInWorkspace: () => void;
  sessionsOnHost: number | null;
}) {
  const [attachInstruction, setAttachInstruction] = useState<AttachInstruction | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [loadingAttach, setLoadingAttach] = useState(false);
  const [facts, setFacts] = useState<SelectedSessionFactsResponse | null>(null);
  const [factsStatus, setFactsStatus] = useState<"loading" | "loaded" | "error">("loading");
  const exactRequestIds = useMemo(() => exactCurrentActivityRequestIds(activity.items), [activity.items]);
  const planApprovalRequestIds = useMemo(() => exactPlanApprovalRequestIds(activity.items, exactRequestIds), [activity.items, exactRequestIds]);
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
  async function revealAttach() {
    setLoadingAttach(true);
    setAttachError(null);
    try {
      const instruction = await loadAttach();
      setAttachInstruction(instruction);
      if (!instruction.available) setAttachError("This harness did not return a guarded resume or attach wrapper.");
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : "Attach details are unavailable.");
    } finally {
      setLoadingAttach(false);
    }
  }
  const controls: ActivityDataControls = {
    attention: {
      exactRequestIds,
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
        {activity.truncated && <ActivityRetentionBoundary />}
        <AuiIf condition={(state) => state.thread.isEmpty}><EmptyActivity connection={activity.connection} truncated={activity.truncated} /></AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) => message.role === "user" ? <UserMessage /> : message.role === "system" ? <SystemMessage label={systemMessageLabel(message)} /> : <AssistantMessage controls={controls} />}
        </ThreadPrimitive.Messages>
        {!session.archived && ["completed", "failed", "interrupted"].includes(session.status) && <div><SessionEndedState canResume={session.control.capabilities.includes("resume")} resumeCommand={attachInstruction?.available ? attachInstruction.command : null} resumeDescription={attachInstruction?.description ?? null} resumeError={attachError} resumeUnavailableReason={session.control.withheld.find(({ capability }) => capability === "resume")?.reason ?? null} loadingResume={loadingAttach} onResume={() => void revealAttach()} canContinue={Boolean(session.workspaceIdentity?.worktreePath ?? session.cwd)} onContinue={onContinueInWorkspace} /></div>}
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

export function SessionThreadComposer({
  session,
  activity,
  busy,
  mutationsReady,
  onSend,
  onInterrupt,
  onSetProfile,
  onSetModel,
  onSetEffort,
  modelOptions,
  modelOptionsStatus,
  effortOptions,
  restoredDraft,
  onOpenSetup,
  onTakeControl,
  onCancelTakeControl,
  onNativeContinue,
  onSearchFiles,
}: {
  session: SessionView;
  activity: SessionActivityView;
  busy: boolean;
  mutationsReady: boolean;
  onSend: (text: string, delivery: "queue" | "steer") => Promise<void>;
  onInterrupt: () => Promise<void>;
  onSetProfile: (profile: ExecutionProfile) => Promise<void>;
  onSetModel: (model: string) => Promise<void>;
  onSetEffort: (effort: ReasoningEffort) => Promise<void>;
  modelOptions: readonly ComposerModelOption[];
  modelOptionsStatus: string | null;
  effortOptions?: readonly ReasoningEffort[];
  restoredDraft?: { key: string; text: string } | null;
  onOpenSetup?: () => void;
  onTakeControl?: (method: TakeoverMethod) => Promise<void>;
  onCancelTakeControl?: (takeoverId: string) => Promise<void>;
  onNativeContinue?: () => Promise<AttachInstruction>;
  /** Absent where the workspace is not readable from here, e.g. a remote host. */
  onSearchFiles?: (query: string) => Promise<readonly string[]>;
}) {
  const [text, setText] = useState("");
  const [takeoverMenuOpen, setTakeoverMenuOpen] = useState(false);
  const [confirmGraceful, setConfirmGraceful] = useState(false);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeInstruction, setNativeInstruction] = useState<AttachInstruction | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  useEffect(() => {
    if (restoredDraft) setText(restoredDraft.text);
  }, [restoredDraft]);
  useEffect(() => {
    setTakeoverMenuOpen(false);
    setConfirmGraceful(false);
    setTakeoverBusy(false);
    setNativeInstruction(null);
    setNativeError(null);
  }, [session.id]);
  const queued = currentQueue(activity);
  const todo = currentTodo(activity);
  const canQueue = session.control.capabilities.includes("queue");
  const canSteer = session.control.capabilities.includes("steer");
  const canStop = session.control.capabilities.includes("interrupt");
  const canSetProfile = session.control.capabilities.includes("set-profile");
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
  const canTakeControl = session.control.capabilities.includes("take-control")
    && takeover !== null
    && (takeover.state === "available" || takeover.state === "failed")
    && onTakeControl !== undefined;
  const canCancelTakeover = session.control.capabilities.includes("cancel-take-control")
    && takeover?.state === "waiting-for-exit"
    && takeover.id !== null
    && onCancelTakeControl !== undefined;
  const hookSetupMissing = onOpenSetup !== undefined && (
    session.control.plane === "observe-only"
    || session.control.withheld.some((item) => /hook (?:bridge|setup)/iu.test(item.reason))
  );
  const canContinueNatively = (!canTakeControl || takeover?.state === "failed")
    && (session.control.capabilities.includes("attach") || session.control.capabilities.includes("resume"))
    && onNativeContinue !== undefined;
  async function beginTakeover(method: TakeoverMethod) {
    if (!onTakeControl) return;
    setTakeoverBusy(true);
    try {
      await onTakeControl(method);
      setTakeoverMenuOpen(false);
      setConfirmGraceful(false);
    } finally {
      setTakeoverBusy(false);
    }
  }
  async function cancelTakeover() {
    if (!canCancelTakeover || !takeover?.id || !onCancelTakeControl) return;
    setTakeoverBusy(true);
    try {
      await onCancelTakeControl(takeover.id);
    } finally {
      setTakeoverBusy(false);
    }
  }
  async function revealNativeContinue() {
    if (!onNativeContinue) return;
    setNativeBusy(true);
    setNativeError(null);
    try {
      const instruction = await onNativeContinue();
      setNativeInstruction(instruction);
      if (!instruction.available) {
        setNativeError("This session does not expose a guarded native continuation.");
      }
    } catch (error) {
      setNativeError(error instanceof Error ? error.message : "Native continuation is unavailable.");
    } finally {
      setNativeBusy(false);
    }
  }
  const unavailableReason = (capability: "set-model" | "set-effort" | "set-profile", fallback: string) =>
    session.control.withheld.find((item) => item.capability === capability)?.reason ?? fallback;
  return (
    <div className="grid gap-3">
      {todo && <TodoList list={todoView(todo, session.todoProgress)} canMessage={canQueue} canStop={canStop && mutationsReady} onAsk={() => setText("What is happening with the current todo?")} onStop={() => void onInterrupt()} />}
      <QueuedMessageCount count={queued.length} />
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
        modelOptions={modelOptions}
        modelOptionsStatus={modelOptionsStatus}
        modelChangeUnavailableReason={canSetModel ? null : unavailableReason("set-model", "This harness does not expose live model changes.")}
        effortChangeUnavailableReason={canSetEffort ? null : unavailableReason("set-effort", "This harness does not expose live effort changes.")}
        profileChangeUnavailableReason={canSetProfile ? null : unavailableReason("set-profile", "This harness does not expose live execution-profile changes.")}
        effortOptions={effortOptions ?? []}
        profileOptions={canSetProfile ? PROFILES : session.profile.value ? [session.profile.value] : []}
        busy={busy}
        {...(canSetModel ? { onModelChange: (model: string) => void onSetModel(model) } : {})}
        {...(canSetEffort ? { onEffortChange: (effort: ReasoningEffort) => void onSetEffort(effort) } : {})}
        {...(canSetProfile ? { onProfileChange: (profile: ExecutionProfile) => void onSetProfile(profile) } : {})}
        {...(onSearchFiles ? { onSearchFiles } : {})}
      />
      {noWriteReason && (
        <div className="grid gap-2 px-0.5 text-code-sm text-[var(--text-muted)]" role="status" data-read-only-state>
          <div className="flex min-h-7 flex-wrap items-center gap-1.5">
            <span>Read only</span>
            {hookSetupMissing && <><span aria-hidden="true">·</span><button type="button" data-read-only-explainer data-compact-control="height" className="underline underline-offset-2" onClick={onOpenSetup}>Enable live activity</button></>}
            {canTakeControl && <><span aria-hidden="true">·</span><button type="button" data-compact-control="height" className="underline underline-offset-2" disabled={!mutationsReady || busy || takeoverBusy} onClick={() => { setTakeoverMenuOpen((open) => !open); setConfirmGraceful(false); }}>Take control</button></>}
            {canContinueNatively && <><span aria-hidden="true">·</span><button type="button" data-compact-control="height" className="underline underline-offset-2" disabled={nativeBusy} onClick={() => void revealNativeContinue()}>{nativeBusy ? "Loading continuation…" : "Continue in CLI"}</button></>}
          </div>
          {takeover?.state === "waiting-for-exit" && <div className="flex flex-wrap items-center gap-2" data-takeover-state><span>Exit the {session.provider === "claude" ? "Claude Code" : "Codex"} CLI to transfer this exact conversation.</span>{canCancelTakeover && <Button variant="ghost" size="sm" data-compact-control disabled={takeoverBusy} onClick={() => void cancelTakeover()}>Cancel takeover</Button>}</div>}
          {takeover?.state === "stopping" && <p data-takeover-state>Stopping the validated CLI process gracefully…</p>}
          {takeover?.state === "adopting" && <p data-takeover-state>Adopting the exact provider conversation…</p>}
          {takeover?.state === "failed" && takeover.error && <p className="text-[var(--warning)]" data-takeover-error>{takeover.error} Retry takeover or continue in the native CLI.</p>}
          {takeoverMenuOpen && canTakeControl && (
            <div className="grid gap-2 border border-[var(--border)] bg-[var(--surface-raised)] p-3" data-takeover-menu>
              <p>Takeover is exclusive. Agent Manager becomes writable only after the current CLI exits and the provider confirms the same conversation.</p>
              {takeover.fallbackProfile && <p className="text-[var(--warning)]">The current profile could not be observed. Adoption will use the conservative <strong>{takeover.fallbackProfile}</strong> profile.</p>}
              {!confirmGraceful ? <div className="flex flex-wrap gap-2"><Button variant="primary" size="sm" disabled={!mutationsReady || takeoverBusy} onClick={() => void beginTakeover("guided-exit")}>{takeoverBusy ? "Starting…" : "Wait for me to exit CLI"}</Button><Button variant="secondary" size="sm" disabled={!mutationsReady || takeoverBusy} onClick={() => setConfirmGraceful(true)}>Stop CLI gracefully…</Button></div> : <div className="grid gap-2"><p>Confirm sending exactly one SIGTERM to the revalidated provider process. Agent Manager waits 15 seconds and never sends SIGKILL.</p><div className="flex flex-wrap gap-2"><Button variant="primary" size="sm" disabled={!mutationsReady || takeoverBusy} onClick={() => void beginTakeover("graceful-stop")}>{takeoverBusy ? "Stopping…" : "Confirm graceful stop"}</Button><Button variant="ghost" size="sm" disabled={takeoverBusy} onClick={() => setConfirmGraceful(false)}>Back</Button></div></div>}
            </div>
          )}
          {nativeInstruction?.available && nativeInstruction.command && <div className="flex items-start gap-2" data-native-continuation><pre className="min-w-0 flex-1 overflow-x-auto bg-[var(--surface-raised)] p-2 font-mono text-code-xs text-[var(--text)]">{nativeInstruction.command}</pre><Button variant="secondary" size="sm" data-compact-control aria-label="Copy native continuation command" onClick={() => void navigator.clipboard?.writeText(nativeInstruction.command ?? "")}><Copy size={13} /></Button></div>}
          {nativeError && <p className="text-[var(--warning)]" data-native-continuation-error>{nativeError}</p>}
        </div>
      )}
      {!mutationsReady && (canQueue || canSteer) && <p className="text-center font-mono text-code-xs text-[var(--warning)]">Offline drafts stay on this device and are sent only if the session state is unchanged.</p>}
    </div>
  );
}
