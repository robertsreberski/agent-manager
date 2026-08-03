import { useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
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
import type {
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

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-3xl justify-end px-4 py-2 md:px-6">
      <div className="min-w-0 max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm [overflow-wrap:anywhere] md:max-w-[78%]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-3xl items-start gap-3 px-4 py-3 md:px-6">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-primary shadow-sm">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 max-w-[calc(100%-2.5rem)] whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
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
      onClick={() => aui.composer().send({ steer: true })}
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
    <div className="border-t bg-background/95 px-4 py-3 backdrop-blur md:px-6">
      <ComposerPrimitive.Root className="mx-auto grid w-full max-w-3xl gap-2 rounded-xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/30">
        <ComposerPrimitive.Input
          disabled={disabled}
          rows={2}
          maxLength={100_000}
          submitMode="enter"
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
            Enter queues · Ctrl/⌘+Shift+Enter steers
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
  const writable = lease !== null;
  const transcript = session.transcript ?? NOT_LOADED_TRANSCRIPT;
  const canQueue = session.control.capabilities.includes("queue");
  const canSteer = session.control.capabilities.includes("steer");
  const queueAdapter = useMemo(() => ({
    items: session.queue,
    enqueue: (message: AppendMessage, options: { steer: boolean }) => {
      const text = messageText(message);
      if (text) void onSend(text, options.steer ? "steer" : "queue").catch(() => undefined);
    },
    steer: () => undefined,
    remove: () => undefined,
    clear: () => undefined,
  }), [onSend, session.queue]);
  const runtime = useExternalStoreRuntime<ConversationMessage>({
    messages: session.messages,
    convertMessage,
    // assistant-ui renders a synthetic in-progress assistant bubble when this
    // is true. Do not show that phantom dot before transcript detail loads.
    isRunning: transcript.state === "available"
      && session.messages.length > 0
      && session.activity === "running",
    isDisabled: !writable || (!canQueue && !canSteer),
    onNew: async (message) => {
      const text = messageText(message);
      if (text) await onSend(text, "queue");
    },
    queue: canQueue || canSteer ? queueAdapter : undefined,
  });

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
      <PendingRequests session={session} writable={writable} busy={busy} onRespond={onRespond} />

      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            className="min-h-0 flex-1 overflow-y-auto scroll-smooth py-3"
            role="region"
            aria-label="Session activity"
            tabIndex={0}
          >
            {transcript.state === "available" && transcript.truncated && (
              <div className="mx-auto mb-2 w-[calc(100%-2rem)] max-w-3xl rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100 md:w-[calc(100%-3rem)]">
                Earlier transcript content is omitted. Showing the latest {transcript.messageCount} messages.
              </div>
            )}
            <ThreadPrimitive.Empty>
              <TranscriptEmptyState session={session} transcript={transcript} />
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            <ThreadPrimitive.ScrollToBottom
              className={cn(
                buttonVariants({ variant: "outline", size: "icon" }),
                "sticky bottom-3 ml-auto mr-4 size-8 rounded-full bg-background shadow-md disabled:hidden",
              )}
            >
              <ArrowDown />
              <span className="sr-only">Scroll to latest message</span>
            </ThreadPrimitive.ScrollToBottom>
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
