import { spawn, type ChildProcess } from "node:child_process";

import type {
  SetupHarnessAvailability,
  SetupHarnessProbe,
} from "../shared/setup.ts";

export interface HarnessProbeOptions {
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
}

function probeOne(
  executable: "codex" | "claude",
  options: HarnessProbeOptions,
): Promise<SetupHarnessAvailability> {
  const timeoutMs = Math.max(250, Math.min(5_000, options.timeoutMs ?? 1_500));
  return new Promise((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let spawned = false;
    const finish = (result: SetupHarnessAvailability): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = (options.spawnProcess ?? spawn)(executable, ["--version"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve({ state: "unavailable", reason: "The harness check could not start." });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ state: "unavailable", reason: "The harness check timed out." });
    }, timeoutMs);
    timer.unref();
    child.once("spawn", () => { spawned = true; });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT"
        ? { state: "missing", reason: `${executable} is not installed on this host.` }
        : { state: "unavailable", reason: "The harness check could not run." });
    });
    child.once("close", () => {
      finish(spawned
        ? { state: "present", reason: null }
        : { state: "unavailable", reason: "The harness check ended before it started." });
    });
  });
}

/** A bounded PATH lookup through each harness's own harmless version command. */
export async function probeLocalHarnesses(
  options: HarnessProbeOptions = {},
): Promise<SetupHarnessProbe> {
  const [codex, claude] = await Promise.all([
    probeOne("codex", options),
    probeOne("claude", options),
  ]);
  return { codex, claude };
}
