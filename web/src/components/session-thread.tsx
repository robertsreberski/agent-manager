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
import { ArrowDown, LoaderCircle, Sparkles } from "lucide-react";
import { reasoningEffortsForProvider } from "../../../src/shared/session.ts";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui";
import { DISCLOSURE_SCROLL_LOCK_MS, GroupedActivityParts } from "./thread";
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
} from "../types";
import { toCockpitSessionView } from "../lib/cockpit-view";
import type { PlanFileResponse, SelectedSessionFactsResponse, SetupHookOffer } from "../lib/api";

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

function SystemMessage() {
  return (
    <MessagePrimitive.Root className="border-l-2 border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-meta-sm text-[var(--text-muted)]" aria-label="System message">
      <MessagePrimitive.Parts />
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

function EmptyActivity({ connection }: { connection: SessionActivityView["connection"] }) {
  return (
    <section className="grid min-h-56 place-content-center gap-3 text-center text-[var(--text-muted)]">
      {connection === "connecting" || connection === "retrying"
        ? <LoaderCircle size={20} className="mx-auto motion-safe:animate-spin" />
        : <Sparkles size={20} className="mx-auto" />}
      <div><h3 className="text-title-sm text-[var(--text)]">{connection === "offline" ? "Activity stream unavailable" : "Waiting for provider activity"}</h3><p className="mt-1 text-meta-sm">Only events the harness actually exposes will appear here.</p></div>
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
        <AuiIf condition={(state) => state.thread.isEmpty}><EmptyActivity connection={activity.connection} /></AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) => message.role === "user" ? <UserMessage /> : message.role === "system" ? <SystemMessage /> : <AssistantMessage controls={controls} />}
        </ThreadPrimitive.Messages>
        {["completed", "failed", "interrupted"].includes(session.status) && <div><SessionEndedState canResume={session.control.capabilities.includes("resume")} resumeCommand={attachInstruction?.available ? attachInstruction.command : null} resumeDescription={attachInstruction?.description ?? null} resumeError={attachError} resumeUnavailableReason={session.control.withheld.find(({ capability }) => capability === "resume")?.reason ?? null} loadingResume={loadingAttach} onResume={() => void revealAttach()} canContinue={Boolean(session.workspaceIdentity?.worktreePath ?? session.cwd)} onContinue={onContinueInWorkspace} /></div>}
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
  hookState,
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
  /** This provider's hook state, once the setup facts have been read. */
  hookState?: SetupHookOffer["state"];
  /** Absent where the workspace is not readable from here, e.g. a remote host. */
  onSearchFiles?: (query: string) => Promise<readonly string[]>;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (restoredDraft) setText(restoredDraft.text);
  }, [restoredDraft]);
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
    ? session.control.withheld.find((item) => item.capability === "queue")?.reason ?? "This harness is observation-only."
    : null;
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
        effortOptions={canSetEffort ? effortOptions ?? reasoningEffortsForProvider(session.provider) : session.effort.value ? [session.effort.value] : []}
        profileOptions={canSetProfile ? PROFILES : session.profile.value ? [session.profile.value] : []}
        busy={busy}
        {...(canSetModel ? { onModelChange: (model: string) => void onSetModel(model) } : {})}
        {...(canSetEffort ? { onEffortChange: (effort: ReasoningEffort) => void onSetEffort(effort) } : {})}
        {...(canSetProfile ? { onProfileChange: (profile: ExecutionProfile) => void onSetProfile(profile) } : {})}
        {...(onSearchFiles ? { onSearchFiles } : {})}
      />
      {/*
        Read-only is honest — an ordinary CLI session exposes no queue or steer
        channel — but the composer used to state the fact without naming the one
        thing that changes it. Where the provider's hook state is known, say
        what it is; the browser still only reads, and the command is still the
        operator's to run.
      */}
      {noWriteReason && onOpenSetup && (
        <div className="grid justify-items-start gap-0.5">
          {hookState === "absent" && (
            <p className="text-code-sm text-[var(--text-muted)]" role="status" data-hook-upgrade="absent">
              No {session.provider} hook is installed. Installing one lets this terminal-started session be answered from here.
            </p>
          )}
          {hookState === "installed-unseen" && (
            <p className="text-code-sm text-[var(--text-muted)]" role="status" data-hook-upgrade="installed-unseen">
              The {session.provider} hook is installed but has not been seen yet — it attaches on this session's next provider event.
            </p>
          )}
          <button type="button" data-read-only-explainer data-compact-control="height" className="min-h-9 text-code-sm text-[var(--text-muted)] underline" onClick={onOpenSetup}>
            {hookState === "absent" ? "Show me the command" : "Why is this read-only?"}
          </button>
        </div>
      )}
      {!mutationsReady && (canQueue || canSteer) && <p className="text-center font-mono text-code-xs text-[var(--warning)]">Offline drafts stay on this device and are sent only if the session state is unchanged.</p>}
    </div>
  );
}
