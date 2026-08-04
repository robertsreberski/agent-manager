import type { SetupHarnessProbe, SetupHostProbe } from "../shared/setup.ts";
import type { RemoteHostState } from "../remote/manager.ts";
import type { HostRecord } from "./persistence.ts";

const UNAVAILABLE: SetupHarnessProbe = {
  codex: { state: "unavailable", reason: "The host could not be checked." },
  claude: { state: "unavailable", reason: "The host could not be checked." },
};

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("setup host probe timed out")), timeoutMs);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function concurrentMap<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await mapper(values[index]!);
    }
  }));
  return result;
}

export async function probeSetupHosts(options: {
  hosts: readonly HostRecord[];
  remoteStates: readonly RemoteHostState[];
  localProbe(): Promise<SetupHarnessProbe>;
  remoteProbe(hostId: string): Promise<SetupHarnessProbe>;
  timeoutMs?: number;
  concurrency?: number;
}): Promise<SetupHostProbe[]> {
  const remoteStates = new Map(options.remoteStates.map((host) => [host.id, host]));
  const timeoutMs = Math.max(500, Math.min(8_000, options.timeoutMs ?? 3_000));
  return concurrentMap(
    options.hosts.slice(0, 32),
    Math.max(1, Math.min(4, options.concurrency ?? 4)),
    async (host) => {
      const remote = remoteStates.get(host.id);
      let harnesses: SetupHarnessProbe;
      try {
        harnesses = await within(
          host.kind === "local" ? options.localProbe() : options.remoteProbe(host.id),
          timeoutMs,
        );
      } catch {
        harnesses = structuredClone(UNAVAILABLE);
      }
      const status = host.kind === "local" ? "online" as const : remote?.status ?? "unknown" as const;
      return {
        id: host.id,
        label: host.label,
        kind: host.kind,
        status,
        statusMessage: remote?.statusMessage?.slice(0, 240) ?? null,
        harnesses,
      };
    },
  );
}
