import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseCodexVersion(value: string): string | null {
  return value.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u)?.[1] ?? null;
}

export async function probeCodexVersion(executable: string): Promise<string | null> {
  const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  return parseCodexVersion(`${stdout}\n${stderr}`);
}
