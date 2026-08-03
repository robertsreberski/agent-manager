import { lazy, Suspense, useState } from "react";
import { AlertCircle, Activity, LoaderCircle, RefreshCw, TriangleAlert, X } from "lucide-react";
import { LaunchDialog } from "./components/launch-dialog";
import { SessionSidebar } from "./components/session-sidebar";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { useCockpit } from "./hooks/use-cockpit";

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

function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/20 px-6">
      <Alert className="max-w-lg border-red-500/30 bg-background shadow-sm">
        <AlertCircle className="mb-3 size-5 text-red-600" />
        <AlertTitle>Agent Manager could not open</AlertTitle>
        <AlertDescription className="mt-1 leading-6">{message}</AlertDescription>
        <Button className="mt-4" onClick={() => window.location.reload()}>
          <RefreshCw /> Try again
        </Button>
      </Alert>
    </main>
  );
}

export default function App() {
  const cockpit = useCockpit();
  const [launchOpen, setLaunchOpen] = useState(false);

  if (cockpit.authError) return <ErrorScreen message={cockpit.authError} />;
  if (!cockpit.ready) return <LoadingScreen />;

  const selected = cockpit.selectedSession;
  const lease = selected ? cockpit.validLease(selected) : null;
  const selectedBusy = selected
    ? Boolean(cockpit.busy[`action:${selected.id}`] || cockpit.busy[`lease:${selected.id}`])
    : false;

  return (
    <main className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <h1 className="sr-only md:hidden">Agent Manager</h1>
      <SessionSidebar
        sessions={cockpit.sessions}
        selectedId={cockpit.selectedId}
        connection={cockpit.connection}
        actor={cockpit.actor}
        onSelect={cockpit.setSelectedId}
        onLaunch={() => setLaunchOpen(true)}
        onRefresh={() => void cockpit.refresh().catch(() => undefined)}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        {cockpit.snapshot.stale && (
          <div className="z-30 flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">
            <TriangleAlert className="size-3.5" /> Discovery is stale; showing the last known snapshot.
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

        {cockpit.actionError && (
          <div className="absolute left-1/2 top-3 z-50 flex w-[min(calc(100%-2rem),36rem)] -translate-x-1/2 items-start gap-2 rounded-lg border border-red-500/30 bg-background px-3 py-2.5 text-sm shadow-lg">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
            <span className="flex-1">{cockpit.actionError}</span>
            <Button size="icon" variant="ghost" className="size-6" onClick={cockpit.clearActionError} aria-label="Dismiss error">
              <X />
            </Button>
          </div>
        )}
        {cockpit.notice && !cockpit.actionError && (
          <div className="absolute left-1/2 top-3 z-50 flex w-fit max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-2 text-xs shadow-lg">
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
                Launch managed session
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
    </main>
  );
}
