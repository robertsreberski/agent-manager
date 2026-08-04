import { useEffect, useMemo, useState } from "react";
import {
  AuiIf,
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Bot, LoaderCircle, Sparkles } from "lucide-react";
import { reasoningEffortsForProvider } from "../../../src/shared/session.ts";
import { GroupedActivityParts } from "./thread";
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
  AttachInstruction,
  ExecutionProfile,
  ReasoningEffort,
  RequestResponse,
  SessionActivityView,
  SessionView,
} from "../types";
import { toCockpitSessionView } from "../lib/cockpit-view";
import type { PlanFileResponse, SelectedSessionFactsResponse } from "../lib/api";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ml-auto my-3 max-w-[88%] rounded-[14px_14px_4px_14px] bg-[var(--surface-selected-active)] px-3.5 py-2.5 text-[14px] leading-[21px] text-[var(--text)] sm:max-w-[78%]" data-user-message>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function SystemMessage() {
  return (
    <MessagePrimitive.Root className="my-3 border-l-2 border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-[12.5px] leading-5 text-[var(--text-muted)]" aria-label="System message">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ controls }: { controls: ActivityDataControls }) {
  return (
    <MessagePrimitive.Root className="my-3 grid grid-cols-[24px_minmax(0,1fr)] items-start gap-3" data-assistant-message>
      <span className="mt-0.5 grid size-6 place-items-center bg-[var(--surface-raised)] text-[var(--text-muted)]"><Bot size={13} /></span>
      <div className="min-w-0 text-[14px] leading-[22px]">
        <GroupedActivityParts renderData={(name, data) => renderActivityData(name, data, controls)} />
      </div>
    </MessagePrimitive.Root>
  );
}

function EmptyActivity({ connection }: { connection: SessionActivityView["connection"] }) {
  return (
    <section className="grid min-h-56 place-content-center gap-3 text-center text-[var(--text-muted)]">
      {connection === "connecting" || connection === "retrying"
        ? <LoaderCircle size={20} className="mx-auto motion-safe:animate-spin" />
        : <Sparkles size={20} className="mx-auto" />}
      <div><h3 className="text-[14px] font-semibold text-[var(--text)]">{connection === "offline" ? "Activity stream unavailable" : "Waiting for provider activity"}</h3><p className="mt-1 text-[12.5px]">Only events the harness actually exposes will appear here.</p></div>
    </section>
  );
}

function SessionDetails({ session, remote, facts, factsStatus, attachInstruction, attachError, loadingAttach, onRevealAttach }: { session: SessionView; remote: boolean; facts: SelectedSessionFactsResponse | null; factsStatus: "loading" | "loaded" | "error"; attachInstruction: AttachInstruction | null; attachError: string | null; loadingAttach: boolean; onRevealAttach: () => void }) {
  const view = toCockpitSessionView(session, { remote });
  const attachCommand = attachInstruction?.available ? attachInstruction.command : null;
  return (
    <details className="mb-4 border border-[var(--border)] bg-[var(--surface-raised)]">
      <summary className="flex min-h-10 cursor-pointer items-center px-3 text-[12.5px] font-medium">Session facts and capabilities</summary>
      <div className="grid gap-4 border-t border-[var(--rule)] p-3">
        <SessionCapabilityPanel session={view} facts={facts} factsStatus={factsStatus} attachCommand={attachCommand} attachError={attachError} loadingAttach={loadingAttach} onRevealAttach={onRevealAttach} />
      </div>
    </details>
  );
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
  const messages = useMemo(() => activityToThreadMessages(activity.items), [activity.items]);
  const exactRequestIds = useMemo(() => exactCurrentActivityRequestIds(activity.items), [activity.items]);
  const planApprovalRequestIds = useMemo(() => exactPlanApprovalRequestIds(activity.items, exactRequestIds), [activity.items, exactRequestIds]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    // Per-item status is authoritative. The runtime must not invent an empty
    // assistant message merely because the provider has an active turn.
    isRunning: false,
    isDisabled: true,
    onNew: async () => undefined,
  });
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
      onRemove: onRemoveQueued,
    },
  };
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <div role="log" aria-label="Provider activity" aria-live="polite" aria-relevant="additions text">
          <SessionDetails session={session} remote={remote} facts={facts} factsStatus={factsStatus} attachInstruction={attachInstruction} attachError={attachError} loadingAttach={loadingAttach} onRevealAttach={() => void revealAttach()} />
          {activity.truncated && <ActivityRetentionBoundary />}
          <AuiIf condition={(state) => state.thread.isEmpty}><EmptyActivity connection={activity.connection} /></AuiIf>
          <ThreadPrimitive.Messages>
            {({ message }) => message.role === "user" ? <UserMessage /> : message.role === "system" ? <SystemMessage /> : <AssistantMessage controls={controls} />}
          </ThreadPrimitive.Messages>
          {["completed", "failed", "interrupted"].includes(session.status) && <div className="mt-5"><SessionEndedState canResume={session.control.capabilities.includes("resume")} resumeCommand={attachInstruction?.available ? attachInstruction.command : null} resumeDescription={attachInstruction?.description ?? null} resumeError={attachError} resumeUnavailableReason={session.control.withheld.find(({ capability }) => capability === "resume")?.reason ?? null} loadingResume={loadingAttach} onResume={() => void revealAttach()} canContinue={Boolean(session.workspaceIdentity?.worktreePath ?? session.cwd)} onContinue={onContinueInWorkspace} /></div>}
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
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
        modelOptions={canSetModel ? modelOptions : []}
        modelOptionsStatus={canSetModel ? modelOptionsStatus : null}
        modelChangeUnavailableReason={canSetModel ? null : unavailableReason("set-model", "This harness does not expose live model changes.")}
        effortChangeUnavailableReason={canSetEffort ? null : unavailableReason("set-effort", "This harness does not expose live effort changes.")}
        profileChangeUnavailableReason={canSetProfile ? null : unavailableReason("set-profile", "This harness does not expose live execution-profile changes.")}
        effortOptions={canSetEffort ? effortOptions ?? reasoningEffortsForProvider(session.provider) : session.effort.value ? [session.effort.value] : []}
        profileOptions={canSetProfile ? PROFILES : session.profile.value ? [session.profile.value] : []}
        busy={busy}
        {...(canSetModel ? { onModelChange: (model: string) => void onSetModel(model) } : {})}
        {...(canSetEffort ? { onEffortChange: (effort: ReasoningEffort) => void onSetEffort(effort) } : {})}
        {...(canSetProfile ? { onProfileChange: (profile: ExecutionProfile) => void onSetProfile(profile) } : {})}
      />
      {!mutationsReady && (canQueue || canSteer) && <p className="text-center font-mono text-[10.5px] text-[var(--warning)]">Offline drafts stay on this device and are sent only if the session state is unchanged.</p>}
    </div>
  );
}
