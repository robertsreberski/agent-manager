import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The handoff's type ladder from `styles.css` (spec 12 R6). tailwind-merge only
 * knows its own default scale, so it files an unrecognised `text-*` under
 * text-COLOR — which meant `text-meta-sm` silently evicted
 * `text-[var(--accent-ink)]` from the same group. On a filled lime button that
 * left near-white ink on `--accent`, roughly 1.2:1. Declaring the scale as
 * font-size puts the two in different groups so both survive.
 */
const TYPE_SCALE = [
  "display", "display-md", "display-sm",
  "title", "title-md", "title-sm",
  "card",
  "body", "body-sm",
  "meta", "meta-sm",
  "code", "code-sm", "code-xs",
  "eyebrow",
] as const;

const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...TYPE_SCALE] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function truncateMiddle(value: string, length = 46): string {
  if (value.length <= length) return value;
  const half = Math.floor((length - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

export function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "Unknown";
  const delta = Math.max(0, Date.now() - then);
  if (delta < 5_000) return "Now";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
