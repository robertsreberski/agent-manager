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
  LoaderCircle,
  PanelRightOpen,
  Send,
  SlidersHorizontal,
  Sparkles,
  WifiOff,
} from "lucide-react";
import { AccessSheet } from "./access-sheet";
import { PendingRequests } from "./pending-requests";
import {
  ActivityMessageParts,
  activityToThreadMessage,
  buildActivityTimeline,
  type ActivityAttentionControls,
  type ActivityTimelineItem,
} from "./session-activity";
import {
  AccessBadge,
  ModeBadge,
} from "./session-badges";
import { Badge, type BadgeProps } from "./ui/badge";
import { Button, buttonVariants } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useSessionActivity } from "../hooks/use-session-activity";
import type {
  ActivityItem,
  AttentionRequest,
  AttachInstruction,
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

type TimelineMessage = ConversationMessage | ActivityTimelineItem;

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
        ...(question.header ? { header: question.header } : {}),
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

export function exactCurrentActivityRequestIds(items: ActivityItem[]): ReadonlySet<string> {
  const resolvedRequestIds = new Set(
    items.flatMap((item) => item.kind === "attention" && item.resolved && item.requestId
      ? [item.requestId]
      : []),
  );
  return new Set(
    items.flatMap((item) => item.kind === "attention"
        && !item.resolved
        && item.state === "waiting"
        && item.source === "provider-api"
        && item.confidence === "exact"
        && item.exposure === "provider-exposed"
        && !item.truncated
        && item.requestId
        && !resolvedRequestIds.has(item.requestId)
      ? [item.requestId]
      : []),
  );
}

export function mergePendingAttentionRequests(
  items: ActivityItem[],
  metadataRequests: AttentionRequest[],
): AttentionRequest[] {
  const resolvedRequestIds = new Set(
    items.flatMap((item) => item.kind === "attention" && item.resolved && item.requestId
      ? [item.requestId]
      : []),
  );
  const activityRequests = activityAttentionRequests(items).filter((request) =>
    !request.id || !resolvedRequestIds.has(request.id),
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
      // Response shape must come from the current activity request. Metadata
      // may enrich display-only context, but it is not authoritative enough to
      // synthesize answer controls.
      prompt: null,
      options: [],
      multiple: false,
      questions: request.questions ?? [],
      isSecret: Boolean(request.isSecret || fallback.isSecret),
    };
  });

  const metadataFallbacks = metadataRequests
    .filter((request) =>
      !request.id || (!activityRequestIds.has(request.id) && !resolvedRequestIds.has(request.id)),
    )
    .map((request) => ({ ...request, respondable: false }));
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

function AssistantMessage({ controls }: { controls: ActivityAttentionControls }) {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-3xl items-start gap-2 px-3 py-3 sm:gap-3 sm:px-4 md:px-6">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-primary shadow-sm">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
        <ActivityMessageParts controls={controls} />
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
        Provider-reported commentary, tools, plans, and messages will appear here.
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

function SteerButton({ enabled, primary = false }: { enabled: boolean; primary?: boolean }) {
  const aui = useAui();
  const canSend = useAuiState((state) => state.composer.canSend);
  return (
    <Button
      type="button"
      variant={primary ? "default" : "outline"}
      disabled={!enabled || !canSend}
      onClick={() => aui.composer.send({ steer: true })}
      title="Interrupt the current turn with this message"
    >
      <ArrowRight /> Steer
    </Button>
  );
}

function AgentComposer({
  running,
  canQueue,
  canSteer,
  mutationsReady,
  queueCount,
}: {
  running: boolean;
  canQueue: boolean;
  canSteer: boolean;
  mutationsReady: boolean;
  queueCount: number;
}) {
  const disabled = !mutationsReady || (!canQueue && !canSteer);
  return (
    <div className="border-t bg-background/95 px-3 pt-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-4 md:px-6">
      <ComposerPrimitive.Root className="mx-auto grid w-full max-w-3xl gap-2 rounded-xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/30">
        <div className="flex min-w-0 flex-wrap gap-1.5 empty:hidden" aria-label="Queued messages">
          <ComposerPrimitive.Queue>
            {() => (
              <div className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full border bg-muted/35 px-2.5 py-1 text-xs">
                <Clock3 className="size-3 shrink-0 text-muted-foreground" />
                <QueueItemPrimitive.Text className="min-w-0 max-w-64 truncate" />
              </div>
            )}
          </ComposerPrimitive.Queue>
        </div>
        {!mutationsReady && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200">
            <WifiOff className="size-3.5" /> Reconnect to continue
          </div>
        )}
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
            !mutationsReady
              ? "Reconnect to continue"
              : running && canSteer
                  ? "Steer the running turn…"
                  : canQueue
                    ? "Message this session…"
                    : "Steer the current turn…"
          }
          className="max-h-40 min-h-12 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <div className="flex flex-col-reverse items-stretch justify-between gap-2 sm:flex-row sm:items-center">
          <p className="px-1 text-[11px] text-muted-foreground">
            {queueCount > 0 ? `${queueCount} queued · ` : ""}
            {!mutationsReady
              ? "Read-only while reconnecting"
              : running && canQueue && canSteer
                  ? "Enter queues · Shift+Enter adds a line · Ctrl/⌘+Shift+Enter steers"
                  : running && canQueue
                    ? "Enter queues · Shift+Enter adds a line"
                    : canQueue && canSteer
                      ? "Enter sends · Shift+Enter adds a line · Ctrl/⌘+Shift+Enter steers"
                      : canQueue
                        ? "Enter sends · Shift+Enter adds a line"
                        : "Ctrl/⌘+Shift+Enter steers · Shift+Enter adds a line"}
          </p>
          <div className="flex items-center justify-end gap-2">
            {mutationsReady && running && canSteer && (
              <SteerButton enabled primary />
            )}
            {mutationsReady && canQueue && (
              <ComposerPrimitive.Send
                className={buttonVariants({ variant: running && canSteer ? "outline" : "default" })}
              >
                {running ? <Clock3 className="size-4" /> : <Send className="size-4" />}
                {running ? "Queue" : "Send"}
              </ComposerPrimitive.Send>
            )}
            {mutationsReady && !running && !canQueue && canSteer && (
              <SteerButton enabled primary />
            )}
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
  mutationsReady,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  mutationsReady: boolean;
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
            disabled={busy || !mutationsReady}
            onClick={() => void onConfirm().then(() => onOpenChange(false)).catch(() => undefined)}
          >
            <CircleStop /> {busy ? "Interrupting…" : "Interrupt turn"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SessionHeader({
  session,
  busy,
  attentionCount,
  mutationsReady,
  onAccess,
  onSetMode,
  onInterrupt,
}: {
  session: SessionView;
  busy: boolean;
  attentionCount: number;
  mutationsReady: boolean;
  onAccess: () => void;
  onSetMode: (mode: "planning" | "execution") => Promise<void>;
  onInterrupt: () => Promise<void>;
}) {
  const [interruptDialog, setInterruptDialog] = useState(false);
  const status: { label: string; variant: BadgeProps["variant"] } = attentionCount > 0 || session.activity === "waiting"
    ? { label: "Needs you", variant: "warning" }
    : session.activity === "running"
      ? { label: "Working", variant: "success" }
      : session.activity === "failed"
        ? { label: "Failed", variant: "danger" }
        : session.activity === "interrupted"
          ? { label: "Stopped", variant: "warning" }
          : session.activity === "completed"
            ? { label: "Completed", variant: "success" }
            : session.activity === "unknown"
              ? { label: "Unknown", variant: "outline" }
              : session.runtimeAlive
                ? { label: "Ready", variant: "outline" }
                : { label: "Offline", variant: "secondary" };
  const targetMode = session.mode.value === "planning" ? "execution" : "planning";
  return (
    <>
      <header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b bg-background pl-[calc(3.5rem+env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] min-[640px]:pr-4 min-[901px]:h-14 min-[901px]:px-6 min-[901px]:pt-0">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <h2 className="mr-1 min-w-0 truncate text-sm font-semibold sm:text-base">
            {session.name || session.cwd?.split("/").filter(Boolean).at(-1) || `${session.provider} session`}
          </h2>
          <Badge variant={status.variant} title={attentionCount > 0 ? `${attentionCount} request${attentionCount === 1 ? "" : "s"} waiting` : undefined}>
            {status.label}
          </Badge>
          {session.mode.value !== "unknown" && (
            <span className="hidden min-[360px]:contents">
              <ModeBadge mode={session.mode.value} />
            </span>
          )}
          <AccessBadge accessMode={session.effectiveAccess.accessMode} />
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {session.control.capabilities.includes("set-mode") && session.mode.value !== "unknown" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !mutationsReady}
              onClick={() => void onSetMode(targetMode).catch(() => undefined)}
              aria-label={`Switch to ${targetMode === "planning" ? "Plan" : "Execute"}`}
            >
              <SlidersHorizontal />
              <span className="hidden lg:inline">{targetMode === "planning" ? "Plan" : "Execute"}</span>
            </Button>
          )}
          {session.control.capabilities.includes("interrupt") && session.activity === "running" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !mutationsReady}
              onClick={() => setInterruptDialog(true)}
            >
              <CircleStop /> <span>Stop</span>
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-8" onClick={onAccess} aria-label="Session details">
            <PanelRightOpen />
          </Button>
        </div>
      </header>
      <ConfirmInterrupt
        open={interruptDialog}
        onOpenChange={setInterruptDialog}
        busy={busy}
        mutationsReady={mutationsReady}
        onConfirm={onInterrupt}
      />
    </>
  );
}

export function SessionThread({
  session,
  busy,
  mutationsReady = true,
  onSend,
  onRespond,
  onInterrupt,
  onSetMode,
  loadPreview,
  loadAttach,
}: {
  session: SessionView;
  busy: boolean;
  mutationsReady?: boolean;
  onSend: (text: string, delivery: "queue" | "steer") => Promise<void>;
  onRespond: (requestId: string, response: RequestResponse) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onSetMode: (mode: "planning" | "execution") => Promise<void>;
  loadPreview: (session: SessionView) => Promise<PanePreview>;
  loadAttach: (session: SessionView) => Promise<AttachInstruction>;
}) {
  const [accessOpen, setAccessOpen] = useState(false);
  const [unseenUpdates, setUnseenUpdates] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const lastFollowRevisionRef = useRef<{ source: "activity" | "transcript"; revision: number }>({
    source: "transcript",
    revision: 0,
  });
  const transcript = session.transcript ?? NOT_LOADED_TRANSCRIPT;
  const activity = useSessionActivity(session.id);
  const hasLiveActivity = activity.hasSnapshot;
  const timelineMessages: TimelineMessage[] = useMemo(
    () => hasLiveActivity ? buildActivityTimeline(activity.items) : session.messages,
    [activity.items, hasLiveActivity, session.messages],
  );
  const pendingRequests = useMemo(
    () => hasLiveActivity
      ? mergePendingAttentionRequests(activity.items, session.attention)
      : session.attention,
    [activity.items, hasLiveActivity, session.attention],
  );
  const exactRequestIds = useMemo(
    () => hasLiveActivity ? exactCurrentActivityRequestIds(activity.items) : new Set<string>(),
    [activity.items, hasLiveActivity],
  );
  const canQueue = session.control.capabilities.includes("queue");
  const canSteer = session.control.capabilities.includes("steer");
  const queueAdapter = useMemo(() => ({
    items: session.queue,
    enqueue: (message: AppendMessage, options: { steer: boolean }) => {
      if (!mutationsReady) return;
      const text = messageText(message);
      const delivery = options.steer ? "steer" : "queue";
      const supported = options.steer ? canSteer : canQueue;
      if (text && supported) void onSend(text, delivery).catch(() => undefined);
    },
    steer: () => undefined,
    remove: () => undefined,
    clear: () => undefined,
  }), [canQueue, canSteer, mutationsReady, onSend, session.queue]);
  const runtime = useExternalStoreRuntime<TimelineMessage>({
    messages: timelineMessages,
    convertMessage: convertTimelineMessage,
    // Item-level statuses carry live state. Keeping the thread itself false
    // prevents assistant-ui from inventing an empty running message.
    isRunning: false,
    isDisabled: !mutationsReady || (!canQueue && !canSteer),
    onNew: async (message) => {
      const text = messageText(message);
      if (text && canQueue && mutationsReady) await onSend(text, "queue");
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

  const jumpToLive = () => {
    const node = viewportRef.current;
    if (node) scrollToBottom(node);
    followingRef.current = true;
    setUnseenUpdates(0);
  };

  const jumpToAttentionRequest = (requestId: string) => {
    const candidates = viewportRef.current?.querySelectorAll<HTMLElement>("[data-attention-request-id]");
    const target = [...(candidates ?? [])].find((node) => node.dataset.attentionRequestId === requestId);
    if (!target) return;
    const reducedMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.focus({ preventScroll: true });
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    }
  };

  const attentionControls: ActivityAttentionControls = {
    exactRequestIds,
    mutationsReady,
    canRespond: session.control.capabilities.includes("respond"),
    busy,
    onRespond,
  };

  return (
    <div className="flex h-dvh min-w-0 flex-1 flex-col bg-background">
      <SessionHeader
        session={session}
        busy={busy}
        attentionCount={pendingRequests.length}
        mutationsReady={mutationsReady}
        onAccess={() => setAccessOpen(true)}
        onSetMode={onSetMode}
        onInterrupt={onInterrupt}
      />
      <PendingRequests
        session={session}
        requests={pendingRequests}
        exactRequestIds={exactRequestIds}
        mutationsReady={mutationsReady}
        busy={busy}
        onJumpToRequest={jumpToAttentionRequest}
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
            <ThreadPrimitive.Messages>
              {({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage controls={attentionControls} />}
            </ThreadPrimitive.Messages>
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
            <AgentComposer
              running={session.activity === "running"}
              canQueue={canQueue}
              canSteer={canSteer}
              mutationsReady={mutationsReady}
              queueCount={session.queue.length}
            />
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
