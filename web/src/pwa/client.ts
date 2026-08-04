import { useSyncExternalStore } from "react";

export type PwaInstallOutcome = "accepted" | "dismissed" | "unavailable";

export interface PwaClientState {
  installAvailable: boolean;
  standalone: boolean;
  updateReady: boolean;
}

export interface PwaClientApi extends PwaClientState {
  install(): Promise<PwaInstallOutcome>;
  applyUpdate(): Promise<boolean>;
  dismissUpdate(): void;
}

interface DeferredInstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const subscribers = new Set<() => void>();
let deferredInstall: DeferredInstallPrompt | null = null;
let initialized = false;
let waitingServiceWorker: ServiceWorker | null = null;
let updateServiceWorker: ((target: ServiceWorker) => void | Promise<void>) | null = null;

const UPDATE_TAKEOVER_TIMEOUT_MS = 10_000;

interface PendingUpdateTakeover {
  target: ServiceWorker;
  timeout: ReturnType<typeof setTimeout>;
  resolve(applied: boolean): void;
}

let pendingUpdateTakeover: PendingUpdateTakeover | null = null;

function isStandalone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return iosNavigator.standalone === true
    || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

let snapshot: PwaClientState = {
  installAvailable: false,
  standalone: isStandalone(),
  updateReady: false,
};

function publish(patch: Partial<PwaClientState>): void {
  const next = { ...snapshot, ...patch };
  if (
    next.installAvailable === snapshot.installAvailable
    && next.standalone === snapshot.standalone
    && next.updateReady === snapshot.updateReady
  ) return;
  snapshot = next;
  for (const subscriber of subscribers) subscriber();
}

export function getPwaClientState(): PwaClientState {
  return snapshot;
}

export function subscribePwaClient(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export async function requestPwaInstall(): Promise<PwaInstallOutcome> {
  const prompt = deferredInstall;
  if (!prompt) return "unavailable";
  deferredInstall = null;
  publish({ installAvailable: false });
  await prompt.prompt();
  return (await prompt.userChoice).outcome;
}

function finishPendingUpdate(pending: PendingUpdateTakeover, applied: boolean): void {
  if (pendingUpdateTakeover !== pending) return;
  clearTimeout(pending.timeout);
  pendingUpdateTakeover = null;
  if (applied) {
    waitingServiceWorker = null;
  } else if (waitingServiceWorker === pending.target) {
    publish({ updateReady: true });
  }
  pending.resolve(applied);
}

/** Applies a waiting worker and resolves only after that worker takes control. */
export async function applyPwaUpdate(): Promise<boolean> {
  const target = waitingServiceWorker;
  const requestTakeover = updateServiceWorker;
  if (!snapshot.updateReady || !target || !requestTakeover || pendingUpdateTakeover) return false;
  publish({ updateReady: false });
  const outcome = new Promise<boolean>((resolve) => {
    const pending: PendingUpdateTakeover = {
      target,
      timeout: setTimeout(() => finishPendingUpdate(pending, false), UPDATE_TAKEOVER_TIMEOUT_MS),
      resolve,
    };
    pendingUpdateTakeover = pending;
  });
  void Promise.resolve()
    .then(() => requestTakeover(target))
    .catch(() => {
      const pending = pendingUpdateTakeover;
      if (pending?.target === target) finishPendingUpdate(pending, false);
    });
  return await outcome;
}

export function dismissPwaUpdate(): void {
  publish({ updateReady: false });
}

export function usePwaClient(): PwaClientApi {
  const state = useSyncExternalStore(subscribePwaClient, getPwaClientState, getPwaClientState);
  return {
    ...state,
    install: requestPwaInstall,
    applyUpdate: applyPwaUpdate,
    dismissUpdate: dismissPwaUpdate,
  };
}

/** Installs passive browser listeners and registers the production worker once. */
export function initializePwaClient(options: { reload?: () => void } = {}): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const reload = options.reload ?? (() => window.location.reload());

  const displayMode = window.matchMedia?.("(display-mode: standalone)");
  const updateStandalone = (): void => publish({ standalone: isStandalone() });
  displayMode?.addEventListener("change", updateStandalone);

  window.addEventListener("beforeinstallprompt", (event) => {
    const candidate = event as DeferredInstallPrompt;
    if (typeof candidate.prompt !== "function" || !candidate.userChoice) return;
    event.preventDefault();
    deferredInstall = candidate;
    publish({ installAvailable: !isStandalone() });
  });

  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    publish({ installAvailable: false, standalone: isStandalone() });
  });

  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  void import("workbox-window").then(async ({ Workbox }) => {
    const worker = new Workbox("/sw.js", { scope: "/", type: "classic" });
    // Install the takeover sender before registration. Workbox may report a
    // pre-existing waiting worker from inside register(), and the UI must
    // never advertise an update that applyPwaUpdate cannot yet request.
    updateServiceWorker = async (target) => {
      if (waitingServiceWorker !== target) throw new Error("the requested update is no longer waiting");
      worker.messageSkipWaiting();
    };
    let controlled = navigator.serviceWorker.controller !== null;
    worker.addEventListener("waiting", (event) => {
      if (event.sw) waitingServiceWorker = event.sw;
      if (controlled) publish({ updateReady: true });
    });
    worker.addEventListener("installed", (event) => {
      if (!controlled) return;
      if (event.sw) waitingServiceWorker = event.sw;
      if (event.isUpdate || event.isExternal) publish({ updateReady: true });
    });
    worker.addEventListener("controlling", (event) => {
      const wasControlled = controlled;
      controlled = true;
      if (!wasControlled) return;
      const activeWorker = navigator.serviceWorker.controller ?? event.sw ?? null;
      const pending = pendingUpdateTakeover;
      if (
        pending
        && (event.sw === pending.target || activeWorker === pending.target)
      ) {
        finishPendingUpdate(pending, true);
      }
      // Every tab that was already controlled must adopt the new shell. The
      // first install also emits `controlling` because the worker claims
      // clients, but `wasControlled` is false in that case and does not reload.
      reload();
    });
    const registration = await worker.register({ immediate: true });
    if (registration?.waiting) {
      waitingServiceWorker = registration.waiting;
      if (controlled) publish({ updateReady: true });
    }
  }).catch(() => {
    const pending = pendingUpdateTakeover;
    if (pending) finishPendingUpdate(pending, false);
    updateServiceWorker = null;
  });
}
