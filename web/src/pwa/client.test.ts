import { afterEach, expect, it, vi } from "vitest";

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock("workbox-window");
  vi.resetModules();
  if (originalServiceWorker) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

function serviceWorker(id: string): ServiceWorker {
  return { scriptURL: `https://manager.test/sw.js?${id}` } as ServiceWorker;
}

async function productionClient(options: {
  controller: ServiceWorker | null;
  waiting?: ServiceWorker | null;
  waitingDuringRegister?: ServiceWorker;
  skipWaiting?: () => void | Promise<void>;
}) {
  vi.resetModules();
  vi.stubEnv("PROD", true);
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const messageSkipWaiting = vi.fn(options.skipWaiting ?? (() => undefined));
  let resolveRegistered!: () => void;
  const registered = new Promise<void>((resolve) => {
    resolveRegistered = resolve;
  });
  const registration = {
    waiting: options.waiting ?? null,
  } as ServiceWorkerRegistration;
  class WorkboxMock {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    }

    async register(): Promise<ServiceWorkerRegistration> {
      if (options.waitingDuringRegister) {
        for (const listener of listeners.get("waiting") ?? []) {
          listener({ sw: options.waitingDuringRegister });
        }
      }
      resolveRegistered();
      return registration;
    }

    messageSkipWaiting(): void {
      void messageSkipWaiting();
    }
  }
  vi.doMock("workbox-window", () => ({ Workbox: WorkboxMock }));
  const serviceWorkerContainer = { controller: options.controller };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorkerContainer,
  });

  const client = await import("./client");
  const reload = vi.fn();
  client.initializePwaClient({ reload });
  await registered;
  await Promise.resolve();
  await Promise.resolve();

  return {
    client,
    reload,
    messageSkipWaiting,
    serviceWorkerContainer,
    dispatch(type: string, event: Record<string, unknown>): void {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

it("exposes install availability without prompting automatically", async () => {
  vi.resetModules();
  const client = await import("./client");
  const prompt = vi.fn(async () => undefined);
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.defineProperties(event, {
    prompt: { value: prompt },
    userChoice: { value: Promise.resolve({ outcome: "dismissed", platform: "web" }) },
  });

  client.initializePwaClient();
  window.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
  expect(client.getPwaClientState()).toMatchObject({
    installAvailable: true,
    standalone: false,
    updateReady: false,
  });
  await expect(client.requestPwaInstall()).resolves.toBe("dismissed");
  expect(prompt).toHaveBeenCalledOnce();
  expect(client.getPwaClientState().installAvailable).toBe(false);
  await expect(client.applyPwaUpdate()).resolves.toBe(false);
});

it("does not reload when the first installed worker starts controlling the tab", async () => {
  const installed = serviceWorker("first-install");
  const harness = await productionClient({ controller: null });

  harness.serviceWorkerContainer.controller = installed;
  harness.dispatch("controlling", { sw: installed, isUpdate: false });

  expect(harness.reload).not.toHaveBeenCalled();
});

it("reloads an existing controlled tab after an update takes over", async () => {
  const current = serviceWorker("current");
  const updated = serviceWorker("updated");
  const harness = await productionClient({ controller: current });

  harness.serviceWorkerContainer.controller = updated;
  harness.dispatch("controlling", { sw: updated, isUpdate: true });

  expect(harness.reload).toHaveBeenCalledOnce();
});

it("waits for the matching controlling event before reporting an applied update", async () => {
  const current = serviceWorker("current");
  const waiting = serviceWorker("waiting");
  const unrelated = serviceWorker("unrelated");
  const harness = await productionClient({ controller: current, waiting });
  expect(harness.client.getPwaClientState().updateReady).toBe(true);

  let settled = false;
  const applied = harness.client.applyPwaUpdate().finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(harness.messageSkipWaiting).toHaveBeenCalledOnce();
  expect(settled).toBe(false);

  harness.serviceWorkerContainer.controller = unrelated;
  harness.dispatch("controlling", { sw: unrelated, isUpdate: true });
  await Promise.resolve();
  expect(settled).toBe(false);

  harness.serviceWorkerContainer.controller = waiting;
  harness.dispatch("controlling", { sw: waiting, isUpdate: true });
  await expect(applied).resolves.toBe(true);
});

it("can apply a waiting update reported synchronously during registration", async () => {
  const current = serviceWorker("current");
  const waiting = serviceWorker("waiting-during-register");
  const harness = await productionClient({
    controller: current,
    waitingDuringRegister: waiting,
  });
  expect(harness.client.getPwaClientState().updateReady).toBe(true);

  const applied = harness.client.applyPwaUpdate();
  await Promise.resolve();
  expect(harness.messageSkipWaiting).toHaveBeenCalledOnce();
  harness.serviceWorkerContainer.controller = waiting;
  harness.dispatch("controlling", { sw: waiting, isUpdate: true });

  await expect(applied).resolves.toBe(true);
});

it("returns false and re-offers an update when takeover times out", async () => {
  const current = serviceWorker("current");
  const waiting = serviceWorker("waiting");
  const harness = await productionClient({ controller: current, waiting });
  vi.useFakeTimers();

  const applied = harness.client.applyPwaUpdate();
  await vi.advanceTimersByTimeAsync(10_000);

  await expect(applied).resolves.toBe(false);
  expect(harness.client.getPwaClientState().updateReady).toBe(true);
});

it("returns false and re-offers an update when requesting takeover fails", async () => {
  const current = serviceWorker("current");
  const waiting = serviceWorker("waiting");
  const harness = await productionClient({
    controller: current,
    waiting,
    skipWaiting: () => { throw new Error("postMessage failed"); },
  });

  await expect(harness.client.applyPwaUpdate()).resolves.toBe(false);
  expect(harness.client.getPwaClientState().updateReady).toBe(true);
});
