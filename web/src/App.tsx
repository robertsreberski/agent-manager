import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { AlertCircle, Activity, Download, LoaderCircle, LockKeyhole, RefreshCw, Share, TriangleAlert, WifiOff, X } from "lucide-react";
import { LaunchDialog } from "./components/launch-dialog";
import { SessionSidebar } from "./components/session-sidebar";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { useCockpit } from "./hooks/use-cockpit";
import { usePwaClient } from "./pwa/client";

const SessionThread = lazy(() => import("./components/session-thread").then((module) => ({
  default: module.SessionThread,
})));

function LoadingScreen() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Activity className="size-6" />
        </div>
        <h1 className="text-lg font-semibold">Agent Manager</h1>
        <p className="mt-2 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> Establishing a private browser session…
        </p>
      </div>
    </main>
  );
}

function ErrorScreen({
  title = "Agent Manager could not open",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/20 px-6">
      <Alert className="max-w-lg border-red-500/30 bg-background shadow-sm">
        <AlertCircle className="mb-3 size-5 text-red-600" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="mt-1 leading-6">{message}</AlertDescription>
        <Button className="mt-4" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      </Alert>
    </main>
  );
}

function HostUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl border bg-muted/45 text-muted-foreground">
          <WifiOff className="size-5" />
        </div>
        <h1 className="text-base font-semibold">Agent Manager host unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The app shell is ready, but this device cannot reach the private Agent Manager service. No session data is stored offline.
        </p>
        <Button className="mt-4" onClick={onRetry}>
          <RefreshCw /> Reconnect
        </Button>
      </div>
    </main>
  );
}

function launchRequested(): boolean {
  return new URLSearchParams(window.location.search).get("launch") === "1";
}

function clearLaunchRequest(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("launch")) return;
  url.searchParams.delete("launch");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function isIosInstallCandidate(standalone: boolean): boolean {
  if (standalone || typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/u.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export default function App() {
  const cockpit = useCockpit();
  const pwa = usePwaClient();
  const [launchOpen, setLaunchOpen] = useState(launchRequested);
  const [privacyCovered, setPrivacyCovered] = useState(document.visibilityState === "hidden");
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [pwaError, setPwaError] = useState<string | null>(null);
  const attentionCount = useMemo(
    () => cockpit.sessions.reduce((count, session) => count + session.attention.length, 0),
    [cockpit.sessions],
  );
  const manualIosInstall = isIosInstallCandidate(pwa.standalone);
  const installAvailable = !pwa.standalone && (pwa.installAvailable || manualIosInstall);

  const installApp = async () => {
    setPwaError(null);
    if (!pwa.installAvailable) {
      setInstallHelpOpen(true);
      return;
    }
    try {
      const outcome = await pwa.install();
      if (outcome === "unavailable" && manualIosInstall) setInstallHelpOpen(true);
    } catch (error) {
      setPwaError(error instanceof Error ? error.message : "Agent Manager could not be installed.");
    }
  };

  const applyUpdate = async () => {
    if (cockpit.hasBusyAction) {
      setPwaError("Finish the current action before updating Agent Manager.");
      return;
    }
    setUpdating(true);
    setPwaError(null);
    try {
      // Always release at the shared browser-session boundary. Another tab can
      // own a lease that this tab has never observed.
      await cockpit.releaseAllLeases();
      const applied = await pwa.applyUpdate();
      if (!applied) throw new Error("The update is no longer ready. It will be offered again when available.");
      setUpdateConfirmOpen(false);
    } catch (error) {
      setPwaError(error instanceof Error ? error.message : "Agent Manager could not apply the update.");
    } finally {
      setUpdating(false);
    }
  };

  const requestUpdate = () => {
    setPwaError(null);
    if (cockpit.hasBusyAction) {
      setPwaError("Finish the current action before updating Agent Manager.");
      return;
    }
    if (cockpit.hasActiveLeases) {
      setUpdateConfirmOpen(true);
      return;
    }
    void applyUpdate();
  };

  useEffect(() => {
    clearLaunchRequest();
  }, []);

  useEffect(() => {
    const updateVisibility = () => setPrivacyCovered(document.visibilityState === "hidden");
    const cover = () => setPrivacyCovered(true);
    const reveal = () => setPrivacyCovered(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("pagehide", cover);
    window.addEventListener("pageshow", reveal);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("pagehide", cover);
      window.removeEventListener("pageshow", reveal);
    };
  }, []);

  useEffect(() => {
    document.title = attentionCount > 0 ? `(${attentionCount}) Agent Manager` : "Agent Manager";
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (contents?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const operation = attentionCount > 0
      ? badgeNavigator.setAppBadge?.(attentionCount)
      : badgeNavigator.clearAppBadge?.();
    void operation?.catch(() => undefined);
  }, [attentionCount]);

  if (!cockpit.ready && cockpit.availability === "offline") {
    return <HostUnavailable onRetry={() => void cockpit.retryConnection()} />;
  }
  if (cockpit.authError) {
    const locked = cockpit.availability === "locked";
    return (
      <ErrorScreen
        title={locked ? "Agent Manager is locked" : "Private session required"}
        message={cockpit.authError}
        onRetry={() => void cockpit.retryConnection()}
      />
    );
  }
  if (!cockpit.ready) return <LoadingScreen />;

  const selected = cockpit.selectedSession;
  const lease = selected ? cockpit.validLease(selected) : null;
  const selectedBusy = selected
    ? Boolean(cockpit.busy[`action:${selected.id}`] || cockpit.busy[`lease:${selected.id}`])
    : false;

  return (
    <main className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <h1 className="sr-only min-[901px]:hidden">Agent Manager</h1>
      <SessionSidebar
        sessions={cockpit.sessions}
        selectedId={cockpit.selectedId}
        scope={cockpit.scope}
        connection={cockpit.connection}
        actor={cockpit.actor}
        onSelect={cockpit.setSelectedId}
        onScopeChange={cockpit.setScope}
        onLaunch={() => setLaunchOpen(true)}
        onRefresh={() => void cockpit.refresh().catch(() => undefined)}
        canLaunch={cockpit.mutationsReady}
        installAvailable={installAvailable}
        onInstall={() => void installApp()}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        {(cockpit.snapshot.stale || cockpit.connection !== "open") && (
          <div className="z-30 flex min-h-8 items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
            <TriangleAlert className="size-3.5" />
            {cockpit.availability === "offline"
              ? "Offline. Session data is read-only until the host reconnects."
              : "Live updates are reconnecting. Actions are paused."}
          </div>
        )}
        {pwa.updateReady && (
          <div className="z-30 flex min-h-9 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-primary/20 bg-primary/[0.06] px-3 py-1.5 text-xs">
            <span className="font-medium">Agent Manager update ready.</span>
            <span className="text-muted-foreground">Agents keep running; open cockpit tabs will reload.</span>
            <span className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  pwa.dismissUpdate();
                  setPwaError(null);
                }}
              >
                Later
              </Button>
              <Button
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={updating || cockpit.hasBusyAction}
                onClick={requestUpdate}
              >
                {updating ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Update
              </Button>
            </span>
          </div>
        )}
        {cockpit.snapshot.diagnostics.length > 0 && (
          <details className="z-30 border-b bg-muted/40 px-4 py-2 text-xs md:px-6">
            <summary className="cursor-pointer font-medium text-muted-foreground">
              {cockpit.snapshot.diagnostics.length} discovery diagnostic{cockpit.snapshot.diagnostics.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 grid gap-1.5 text-muted-foreground">
              {cockpit.snapshot.diagnostics.slice(-8).map((diagnostic, index) => (
                <li key={`${diagnostic.message}-${index}`}>
                  <span className="font-medium uppercase">{diagnostic.provider ?? "system"}:</span> {diagnostic.message}
                </li>
              ))}
            </ul>
          </details>
        )}

        {(cockpit.actionError || pwaError) && (
          <div className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-50 flex w-[min(calc(100%-2rem),36rem)] items-start gap-2 rounded-lg border border-red-500/30 bg-background px-3 py-2.5 text-sm shadow-lg">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
            <span className="flex-1">{cockpit.actionError || pwaError}</span>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={() => {
                cockpit.clearActionError();
                setPwaError(null);
              }}
              aria-label="Dismiss error"
            >
              <X />
            </Button>
          </div>
        )}
        {cockpit.notice && !cockpit.actionError && !pwaError && (
          <div className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-50 flex w-fit max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs shadow-lg">
            <span>{cockpit.notice}</span>
            <Button size="icon" variant="ghost" className="size-5" onClick={cockpit.clearNotice} aria-label="Dismiss notice">
              <X />
            </Button>
          </div>
        )}

        {selected ? (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>}>
            <SessionThread
              key={selected.id}
              session={selected}
              lease={lease}
              busy={selectedBusy}
              mutationsReady={cockpit.mutationsReady}
              onAcquire={() => cockpit.acquireLease(selected).then(() => undefined)}
              onRelease={() => cockpit.releaseLease(selected)}
              onSend={(text, delivery) => cockpit.sendMessage(selected, text, delivery)}
              onRespond={(requestId, response) => cockpit.respond(selected, requestId, response)}
              onInterrupt={() => cockpit.interrupt(selected)}
              onSetMode={(mode) => cockpit.setMode(selected, mode)}
              loadPreview={cockpit.loadPreview}
              loadAttach={cockpit.loadAttach}
            />
          </Suspense>
        ) : (
          <section className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
            <div className="max-w-md">
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/40">
                <Activity className="size-5 text-muted-foreground" />
              </div>
              <h2 className="text-base font-semibold">No local sessions found</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Agent Manager will list Codex and Claude sessions as they appear. You can also launch a manager-owned session in a configured workspace.
              </p>
              <Button className="mt-4" onClick={() => setLaunchOpen(true)}>
                New session
              </Button>
            </div>
          </section>
        )}
      </div>

      <LaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        workspaces={cockpit.workspaces}
        creating={Boolean(cockpit.busy.create)}
        onCreate={cockpit.createSession}
      />

      <Dialog open={installHelpOpen} onOpenChange={setInstallHelpOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <span className="mb-1 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Download className="size-4" />
            </span>
            <DialogTitle className="text-base">Install Agent Manager</DialogTitle>
            <DialogDescription className="leading-6">
              In Safari, tap the Share button, then choose <strong className="font-medium text-foreground">Add to Home Screen</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/35 px-3 py-2.5 text-sm">
            <Share className="size-4 shrink-0 text-primary" />
            Share → Add to Home Screen
          </div>
          <DialogFooter>
            <Button onClick={() => setInstallHelpOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={updateConfirmOpen} onOpenChange={setUpdateConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Release control and update?</DialogTitle>
            <DialogDescription className="leading-6">
              Agent sessions keep running. Agent Manager will release control held by every tab in this browser session, install the update, and reload those tabs.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdateConfirmOpen(false)} disabled={updating}>Cancel</Button>
            <Button onClick={() => void applyUpdate()} disabled={updating || cockpit.hasBusyAction}>
              {updating ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              Release and update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {privacyCovered && (
        <div className="app-privacy-cover" aria-label="Agent Manager is hidden">
          <div className="text-center">
            <span className="app-privacy-cover__mark mx-auto"><LockKeyhole className="size-5" /></span>
            <p className="mt-3 text-xs font-medium text-muted-foreground">Agent Manager</p>
          </div>
        </div>
      )}
    </main>
  );
}
