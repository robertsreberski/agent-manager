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
let reloadRequired = false;
let updateRequested = false;
let updateServiceWorker: (() => Promise<void>) | null = null;

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

/** Applies a waiting worker. A reload can only follow this explicit user action. */
export async function applyPwaUpdate(): Promise<boolean> {
  if (!snapshot.updateReady || !updateServiceWorker) return false;
  updateRequested = true;
  publish({ updateReady: false });
  if (reloadRequired) {
    window.location.reload();
    return true;
  }
  try {
    await updateServiceWorker();
    return true;
  } catch {
    updateRequested = false;
    publish({ updateReady: true });
    return false;
  }
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
export function initializePwaClient(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

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
    worker.addEventListener("waiting", () => publish({ updateReady: true }));
    worker.addEventListener("installed", (event) => {
      if (event.isUpdate || event.isExternal) publish({ updateReady: true });
    });
    worker.addEventListener("controlling", (event) => {
      if (!event.isUpdate && !event.isExternal) return;
      if (updateRequested) {
        window.location.reload();
        return;
      }
      reloadRequired = true;
      publish({ updateReady: true });
    });
    const registration = await worker.register({ immediate: true });
    if (registration?.waiting) publish({ updateReady: true });
    updateServiceWorker = async () => worker.messageSkipWaiting();
  }).catch(() => {
    updateRequested = false;
  });
}
