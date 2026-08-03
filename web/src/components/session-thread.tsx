import { useEffect, useMemo, useRef, useState } from "react";
import {
  AuiIf,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  QueueItemPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowRight,
  Bot,
  CircleStop,
  Clock3,
  Eye,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Pause,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { AccessSheet } from "./access-sheet";
import { PendingRequests } from "./pending-requests";
import {
  ActivityExpansionProvider,
  ActivityMessageParts,
  activityToThreadMessage,
  type ExpansionCommand,
} from "./session-activity";
import {
  ActivityBadge,
  AttentionBadge,
  FullAccessBadge,
  ModeBadge,
  ProviderBadge,
} from "./session-badges";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button, buttonVariants } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { cn, truncateMiddle } from "../lib/utils";
import { useSessionActivity } from "../hooks/use-session-activity";
import type {
  ActivityItem,
  AttentionRequest,
  AttachInstruction,
  ControlLease,
  ConversationMessage,
  PanePreview,
  RequestResponse,
  SessionTranscript,
  SessionView,
} from "../types";

const NOT_LOADED_TRANSCRIPT: SessionTranscript = {
  state: "not-loaded",
  truncated: false,
  source: null,
  messageCount: 0,
  reason: null,
};

function messageText(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function convertMessage(message: ConversationMessage): ThreadMessageLike {
  const prefix = message.role === "system"
    ? "[System] "
    : message.role === "tool"
      ? `[Tool${message.label ? `: ${message.label}` : ""}] `
      : "";
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: [{ type: "text", text: `${prefix}${message.text}` }],
    ...(message.createdAt ? { createdAt: new Date(message.createdAt) } : {}),
  };
}

type TimelineMessage = ConversationMessage | ActivityItem;

function convertTimelineMessage(message: TimelineMessage): ThreadMessageLike {
  return "kind" in message ? activityToThreadMessage(message) : convertMessage(message);
}

export function activityAttentionRequests(items: ActivityItem[]): AttentionRequest[] {
  return items.flatMap((item) => {
    if (item.kind !== "attention" || item.resolved) return [];
    return [{
      id: item.requestId || null,
      kind: item.attentionKind,
      summary: item.summary,
      ...(item.title ? { title: item.title } : {}),
      respondable: item.respondable,
      isSecret: item.isSecret,
      source: item.source,
      confidence: item.confidence,
      questions: item.questions.map((question) => ({
        id: question.id,
        text: question.text,
        options: question.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        multiSelect: question.multiSelect,
        allowFreeText: question.allowFreeText,
        isSecret: question.isSecret,
      })),
    }];
  });
}

export function mergePendingAttentionRequests(
  items: ActivityItem[],
  metadataRequests: AttentionRequest[],
): AttentionRequest[] {
  const activityRequests = activityAttentionRequests(items);
  const resolvedRequestIds = new Set(
    items.flatMap((item) => item.kind === "attention" && item.resolved && item.requestId
      ? [item.requestId]
      : []),
  );
  const metadataById = new Map(
    metadataRequests.flatMap((request) => request.id ? [[request.id, request] as const] : []),
  );
  const activityRequestIds = new Set(
    activityRequests.flatMap((request) => request.id ? [request.id] : []),
  );

  const mergedActivityRequests = activityRequests.map((request) => {
    const fallback = request.id ? metadataById.get(request.id) : undefined;
    if (!fallback) return request;
    return {
      ...fallback,
      ...request,
      summary: request.summary ?? fallback.summary ?? null,
      questions: request.questions && request.questions.length > 0
        ? request.questions
        : fallback.questions ?? [],
      isSecret: Boolean(request.isSecret || fallback.isSecret),
    };
  });

  const metadataFallbacks = metadataRequests.filter((request) =>
    !request.id || (!activityRequestIds.has(request.id) && !resolvedRequestIds.has(request.id)),
  );
  return [...mergedActivityRequests, ...metadataFallbacks];
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-3xl justify-end px-3 py-2 sm:px-4 md:px-6">
      <div className="min-w-0 max-w-[92%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm [overflow-wrap:anywhere] sm:px-4 md:max-w-[78%]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-3xl items-start gap-2 px-3 py-3 sm:gap-3 sm:px-4 md:px-6">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-primary shadow-sm">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
        <ActivityMessageParts />
      </div>
    </MessagePrimitive.Root>
  );
}

function ActivityEmptyState() {
  return (
    <div className="mx-auto flex min-h-[45dvh] max-w-lg flex-col items-center justify-center px-5 py-8 text-center md:px-6">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/40 text-primary shadow-sm">
        <Sparkles className="size-5" />
      </div>
      <h3 className="text-base font-semibold">No activity yet</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Live reasoning, tool calls, plans, and messages will appear here as the provider reports them.
      </p>
    </div>
  );
}

function nearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 96;
}

function scrollToBottom(node: HTMLElement): void {
  const reducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof node.scrollTo === "function") {
    node.scrollTo({ top: node.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  } else {
    node.scrollTop = node.scrollHeight;
  }
}

function transcriptReason(reason: SessionTranscript["reason"]): string {
  if (reason === "not-found") return "No local transcript file was found for this session.";
  if (reason === "unreadable") return "The local transcript exists but could not be read safely.";
  if (reason === "unsupported") return "This provider does not expose a transcript for this session.";
  return "No transcript is available for this session.";
}

function TranscriptEmptyState({
  session,
  transcript,
}: {
  session: SessionView;
  transcript: SessionTranscript;
}) {
  if (transcript.state === "not-loaded") {
    return (
      <div className="mx-auto flex min-h-[45dvh] max-w-lg flex-col items-center justify-center px-5 py-8 text-center md:px-6">
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/40 text-primary shadow-sm">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
        <h3 className="text-base font-semibold">Loading transcript…</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Reading this session’s local conversation history.
        </p>
      </div>
    );
  }

  if (transcript.state === "unavailable") {
    return (
      <div className="mx-auto flex min-h-[45dvh] max-w-lg flex-col items-center justify-center px-5 py-8 text-center md:px-6">
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground shadow-sm">
          <Bot className="size-5" />
        </div>
        <h3 className="text-base font-semibold">Transcript unavailable</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {transcriptReason(transcript.reason)} Preview / attach may still show the provider’s terminal interface.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[45dvh] max-w-lg flex-col items-center justify-center px-5 py-8 text-center md:px-6">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/40 text-primary shadow-sm">
        {session.ownership === "manager" ? <Sparkles className="size-5" /> : <Bot className="size-5" />}
      </div>
      <h3 className="text-base font-semibold">No transcript messages yet</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {session.ownership === "manager"
          ? "This managed session is ready. New messages will appear here as the provider reports them."
          : "The transcript was loaded successfully, but it does not contain any displayable messages."}
      </p>
    </div>
  );
}

function SteerButton({ enabled }: { enabled: boolean }) {
  const aui = useAui();
  const canSend = useAuiState((state) => state.composer.canSend);
  return (
    <Button
      type="button"
      variant="outline"
      disabled={!enabled || !canSend}
      onClick={() => aui.composer.send({ steer: true })}
      title="Interrupt the current turn with this message"
    >
      <ArrowRight /> Steer now
    </Button>
  );
}

function AgentComposer({
  canQueue,
  canSteer,
  writable,
  queueCount,
}: {
  canQueue: boolean;
  canSteer: boolean;
  writable: boolean;
  queueCount: number;
}) {
  const disabled = !writable || (!canQueue && !canSteer);
  return (
    <div className="border-t bg-background/95 px-3 pt-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-4 md:px-6">
      <ComposerPrimitive.Root className="mx-auto grid w-full max-w-3xl gap-2 rounded-xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/30">
        <ComposerPrimitive.Queue>
          {() => (
            <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/35 px-2.5 py-2 text-xs">
              <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-medium text-muted-foreground">Queued</span>
              <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate" />
            </div>
          )}
        </ComposerPrimitive.Queue>
        <ComposerPrimitive.Input
          disabled={disabled}
          rows={2}
          maxLength={100_000}
          submitMode="enter"
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            const steerShortcut = event.shiftKey && (event.ctrlKey || event.metaKey);
            if ((steerShortcut && !canSteer) || (!event.shiftKey && !canQueue)) {
              // assistant-ui clears the composer before calling its queue adapter.
              // Stop unsupported delivery modes here so the draft remains intact.
              event.preventDefault();
            }
          }}
          placeholder={
            !writable
              ? "Take control to send a message"
              : canQueue
                ? "Send work to this session…"
                : "Steer the current turn…"
          }
          className="max-h-40 min-h-14 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <div className="flex flex-col-reverse items-stretch justify-between gap-2 sm:flex-row sm:items-center">
          <p className="px-1 text-[11px] text-muted-foreground">
            {queueCount > 0 ? `${queueCount} queued · ` : ""}
            {canQueue && canSteer
              ? "Enter queues · Ctrl/⌘+Shift+Enter steers"
              : canQueue
                ? "Enter queues · Steering unavailable"
                : "Ctrl/⌘+Shift+Enter steers · Queueing unavailable"}
          </p>
          <div className="flex items-center justify-end gap-2">
            <SteerButton enabled={writable && canSteer} />
            <ComposerPrimitive.Send
              disabled={!writable || !canQueue}
              className={buttonVariants({ variant: "default" })}
            >
              <Clock3 className="size-4" /> Queue
            </ComposerPrimitive.Send>
          </div>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}

function ConfirmInterrupt({
  open,
  onOpenChange,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Interrupt the current turn?</DialogTitle>
          <DialogDescription>
            This requests a provider-level interruption. Queued messages may remain queued and will not be discarded automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Keep running</Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void onConfirm().then(() => onOpenChange(false)).catch(() => undefined)}
          >
            <CircleStop /> {busy ? "Interrupting…" : "Interrupt turn"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmLease({
  session,
  open,
  onOpenChange,
  busy,
  onConfirm,
}: {
  session: SessionView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onConfirm: () => Promise<void>;
}) {
  const fullHost = session.effectiveAccess.fullHostAccess;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{fullHost ? "Arm full-host controls?" : "Take control of this session?"}</DialogTitle>
          <DialogDescription>
            {fullHost
              ? "For five minutes, actions from this browser can direct an agent with unrestricted host access. Review every request carefully."
              : "This browser receives the only writable lease for five minutes. Other cockpit browsers stay read-only."}
          </DialogDescription>
        </DialogHeader>
        {fullHost && (
          <Alert className="border-red-500/40 bg-red-500/5">
            <ShieldAlert className="mb-2 size-4 text-red-600" />
            <AlertTitle>Not sandboxed</AlertTitle>
            <AlertDescription>This session may read, edit, or execute outside its workspace.</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={fullHost ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void onConfirm().then(() => onOpenChange(false)).catch(() => undefined)}
          >
            <KeyRound /> {busy ? "Acquiring…" : fullHost ? "Arm for five minutes" : "Take control"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SessionHeader({
  session,
  lease,
  busy,
  onAccess,
  onAcquire,
  onRelease,
  onSetMode,
  onInterrupt,
}: {
  session: SessionView;
  lease: ControlLease | null;
  busy: boolean;
  onAccess: () => void;
  onAcquire: () => Promise<void>;
  onRelease: () => Promise<void>;
  onSetMode: (mode: "planning" | "execution") => Promise<void>;
  onInterrupt: () => Promise<void>;
}) {
  const [leaseDialog, setLeaseDialog] = useState(false);
  const [interruptDialog, setInterruptDialog] = useState(false);
  const writable = lease !== null;
  const hasControl = session.control.capabilities.some((capability) =>
    capability === "queue" || capability === "steer" || capability === "interrupt" || capability === "respond" || capability === "set-mode",
  );
  const canAccess = Boolean(session.terminal) || session.control.capabilities.includes("attach") || session.control.capabilities.includes("resume") || session.control.capabilities.includes("preview");
  return (
    <>
      <header className="border-b bg-background px-4 py-3 pl-16 md:px-6 md:pl-6">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="mr-1 truncate text-base font-semibold">
                {session.name || session.cwd?.split("/").filter(Boolean).at(-1) || `${session.provider} session`}
              </h2>
              <ProviderBadge provider={session.provider} />
              <ActivityBadge activity={session.activity} />
              <ModeBadge mode={session.mode.value} />
              <AttentionBadge count={session.attention.length} />
              {session.effectiveAccess.fullHostAccess && <FullAccessBadge />}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="truncate font-mono" title={session.cwd ?? undefined}>{session.cwd ?? "No workspace"}</span>
              <span title={session.id}>#{truncateMiddle(session.id, 22)}</span>
              <span className="capitalize">{session.ownership} · {session.control.plane}</span>
              {session.mode.providerValue && <span>provider mode: {session.mode.providerValue}</span>}
              <span title="How Agent Manager determined the current mode">
                mode evidence: {session.mode.confidence} · {session.mode.source}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canAccess && (
              <Button variant="outline" size="sm" onClick={onAccess}>
                <Eye /> Preview / attach
              </Button>
            )}
            {session.control.capabilities.includes("set-mode") && writable && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void onSetMode(session.mode.value === "planning" ? "execution" : "planning").catch(() => undefined)}
              >
                <SlidersHorizontal /> {session.mode.value === "planning" ? "Switch to execute" : "Switch to plan"}
              </Button>
            )}
            {session.control.capabilities.includes("interrupt") && session.activity === "running" && (
              <Button variant="outline" size="sm" disabled={!writable || busy} onClick={() => setInterruptDialog(true)}>
                <Pause /> Interrupt
              </Button>
            )}
            {hasControl && (
              writable ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onRelease().catch(() => undefined)}>
                  <LockKeyhole /> Release control
                </Button>
              ) : (
                <Button
                  variant={session.effectiveAccess.fullHostAccess ? "destructive" : "default"}
                  size="sm"
                  disabled={busy}
                  onClick={() => setLeaseDialog(true)}
                >
                  <KeyRound /> {session.effectiveAccess.fullHostAccess ? "Arm control" : "Take control"}
                </Button>
              )
            )}
          </div>
        </div>
      </header>
      <ConfirmLease
        session={session}
        open={leaseDialog}
        onOpenChange={setLeaseDialog}
        busy={busy}
        onConfirm={onAcquire}
      />
      <ConfirmInterrupt
        open={interruptDialog}
        onOpenChange={setInterruptDialog}
        busy={busy}
        onConfirm={onInterrupt}
      />
    </>
  );
}

export function SessionThread({
  session,
  lease,
  busy,
  onAcquire,
  onRelease,
  onSend,
  onRespond,
  onInterrupt,
  onSetMode,
  loadPreview,
  loadAttach,
}: {
  session: SessionView;
  lease: ControlLease | null;
  busy: boolean;
  onAcquire: () => Promise<void>;
  onRelease: () => Promise<void>;
  onSend: (text: string, delivery: "queue" | "steer") => Promise<void>;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onSetMode: (mode: "planning" | "execution") => Promise<void>;
  loadPreview: (session: SessionView) => Promise<PanePreview>;
  loadAttach: (session: SessionView) => Promise<AttachInstruction>;
}) {
  const [accessOpen, setAccessOpen] = useState(false);
  const [expansion, setExpansion] = useState<ExpansionCommand>({ mode: "auto", revision: 0 });
  const [unseenUpdates, setUnseenUpdates] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const lastFollowRevisionRef = useRef<{ source: "activity" | "transcript"; revision: number }>({
    source: "transcript",
    revision: 0,
  });
  const writable = lease !== null;
  const transcript = session.transcript ?? NOT_LOADED_TRANSCRIPT;
  const activity = useSessionActivity(session.id);
  const hasLiveActivity = activity.hasSnapshot;
  const timelineMessages: TimelineMessage[] = hasLiveActivity ? activity.items : session.messages;
  const pendingRequests = useMemo(
    () => hasLiveActivity
      ? mergePendingAttentionRequests(activity.items, session.attention)
      : session.attention,
    [activity.items, hasLiveActivity, session.attention],
  );
  const canQueue = session.control.capabilities.includes("queue");
  const canSteer = session.control.capabilities.includes("steer");
  const queueAdapter = useMemo(() => ({
    items: session.queue,
    enqueue: (message: AppendMessage, options: { steer: boolean }) => {
      const text = messageText(message);
      const delivery = options.steer ? "steer" : "queue";
      const supported = options.steer ? canSteer : canQueue;
      if (text && supported) void onSend(text, delivery).catch(() => undefined);
    },
    steer: () => undefined,
    remove: () => undefined,
    clear: () => undefined,
  }), [canQueue, canSteer, onSend, session.queue]);
  const runtime = useExternalStoreRuntime<TimelineMessage>({
    messages: timelineMessages,
    convertMessage: convertTimelineMessage,
    // Item-level statuses carry live state. Keeping the thread itself false
    // prevents assistant-ui from inventing an empty running message.
    isRunning: false,
    isDisabled: !writable || (!canQueue && !canSteer),
    onNew: async (message) => {
      const text = messageText(message);
      if (text && canQueue) await onSend(text, "queue");
    },
    queue: canQueue || canSteer ? queueAdapter : undefined,
  });

  const followSource = hasLiveActivity ? "activity" : "transcript";
  const followRevision = hasLiveActivity ? activity.updateCount : session.messages.length;
  useEffect(() => {
    const previous = lastFollowRevisionRef.current;
    const delta = previous.source === followSource
      ? Math.max(0, followRevision - previous.revision)
      : Math.max(1, followRevision);
    lastFollowRevisionRef.current = { source: followSource, revision: followRevision };
    if (delta === 0) return;
    if (!followingRef.current) {
      setUnseenUpdates((count) => count + delta);
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      const node = viewportRef.current;
      if (node) scrollToBottom(node);
      setUnseenUpdates(0);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [followRevision, followSource]);

  const issueExpansion = (mode: ExpansionCommand["mode"]) => {
    setExpansion((current) => ({ mode, revision: current.revision + 1 }));
  };

  const jumpToLive = () => {
    const node = viewportRef.current;
    if (node) scrollToBottom(node);
    followingRef.current = true;
    setUnseenUpdates(0);
  };

  return (
    <div className="flex h-dvh min-w-0 flex-1 flex-col bg-background">
      <SessionHeader
        session={session}
        lease={lease}
        busy={busy}
        onAccess={() => setAccessOpen(true)}
        onAcquire={onAcquire}
        onRelease={onRelease}
        onSetMode={onSetMode}
        onInterrupt={onInterrupt}
      />
      <PendingRequests
        session={session}
        requests={pendingRequests}
        writable={writable}
        busy={busy}
        onRespond={onRespond}
      />

      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            ref={viewportRef}
            className="min-h-0 flex-1 overflow-y-auto scroll-smooth py-3 motion-reduce:scroll-auto"
            role="log"
            aria-label={hasLiveActivity ? "Live session activity" : "Session transcript"}
            aria-live="polite"
            aria-relevant="additions text"
            tabIndex={0}
            onScroll={(event) => {
              const follows = nearBottom(event.currentTarget);
              followingRef.current = follows;
              if (follows) setUnseenUpdates(0);
            }}
          >
            {hasLiveActivity && (
              <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-1.5 px-3 text-[11px] text-muted-foreground sm:px-4 md:px-6">
                <span className="mr-auto inline-flex items-center gap-1.5">
                  <span className={cn(
                    "size-1.5 rounded-full",
                    activity.connection === "open" ? "bg-primary" : "bg-amber-500",
                  )} />
                  Live activity · {activity.connection}
                </span>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => issueExpansion("expand")}>Expand all</Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => issueExpansion("collapse")}>Collapse all</Button>
              </div>
            )}
            {((hasLiveActivity && activity.truncated) || (!hasLiveActivity && transcript.state === "available" && transcript.truncated)) && (
              <div className="mx-auto mb-2 w-[calc(100%-2rem)] max-w-3xl rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100 md:w-[calc(100%-3rem)]">
                {hasLiveActivity
                  ? "Earlier activity is omitted. Showing the latest available events."
                  : `Earlier transcript content is omitted. Showing the latest ${transcript.messageCount} messages.`}
              </div>
            )}
            <AuiIf condition={(state) => state.thread.isEmpty}>
              {hasLiveActivity
                ? <ActivityEmptyState />
                : <TranscriptEmptyState session={session} transcript={transcript} />}
            </AuiIf>
            <ActivityExpansionProvider command={expansion}>
              <ThreadPrimitive.Messages>
                {({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage />}
              </ThreadPrimitive.Messages>
            </ActivityExpansionProvider>
            {unseenUpdates > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="sticky bottom-3 mx-auto mt-3 flex rounded-full bg-background shadow-md"
                onClick={jumpToLive}
              >
                <ArrowDown /> {unseenUpdates} new update{unseenUpdates === 1 ? "" : "s"} · Jump to live
              </Button>
            )}
          </ThreadPrimitive.Viewport>
          {(canQueue || canSteer) && (
            <AgentComposer canQueue={canQueue} canSteer={canSteer} writable={writable} queueCount={session.queue.length} />
          )}
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>

      <AccessSheet
        session={session}
        open={accessOpen}
        onOpenChange={setAccessOpen}
        loadPreview={loadPreview}
        loadAttach={loadAttach}
      />
    </div>
  );
}
