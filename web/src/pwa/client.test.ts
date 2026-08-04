import { expect, it, vi } from "vitest";

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
