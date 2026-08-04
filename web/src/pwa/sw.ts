/// <reference lib="webworker" />

import { clientsClaim, setCacheNameDetails } from "workbox-core";
import {
  cleanupOutdatedCaches,
  matchPrecache,
  precache,
  type PrecacheEntry,
} from "workbox-precaching";

import { shouldHandleAppNavigation, shouldPrecacheUrl } from "./route-policy";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

setCacheNameDetails({
  prefix: "agent-manager",
  precache: "shell",
});

const precacheManifest = self.__WB_MANIFEST.filter((entry) =>
  shouldPrecacheUrl(typeof entry === "string" ? entry : entry.url, self.location.origin)
);
const precacheUrls = new Set(precacheManifest.map((entry) =>
  new URL(typeof entry === "string" ? entry : entry.url, self.registration.scope).href
));

cleanupOutdatedCaches();
precache(precacheManifest);
clientsClaim();

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (shouldHandleAppNavigation(request, self.location.origin)) {
    event.respondWith((async () => {
      try {
        // Do not put this response in a runtime cache. The server owns freshness.
        return await fetch(request);
      } catch (error) {
        // Only a transport failure may fall back to the versioned precached shell.
        const shell = await matchPrecache(new URL("/index.html", self.registration.scope).href);
        if (shell) return shell;
        throw error;
      }
    })());
    return;
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (
    request.method !== "GET"
    || request.mode === "navigate"
    || url.search
    || !precacheUrls.has(url.href)
  ) return;

  // Known shell subresources are cache-first; no other request is intercepted.
  event.respondWith((async () => await matchPrecache(request) ?? fetch(request))());
});
