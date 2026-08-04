export const SHORTCUT_GROUPS = [
  { label: "Move", rows: [["⌘K", "Anything"], ["J / K", "Next / previous session"], ["1–9", "Jump to a board column"], ["⌘⇧D", "Review this turn's changes"]] },
  { label: "Answer", rows: [["1–9", "Pick an option"], ["↵", "Send"], ["⌘↵", "Allow an inside-workspace approval only"], ["E", "Write a different answer"]] },
  { label: "Write", rows: [["⌘L", "Focus composer"], ["↵", "Queue"], ["⌘⇧↵", "Steer now"], ["⌘.", "Stop the turn"]] },
  { label: "Set", rows: [["M", "Execution profile"], ["⌘⇧M", "Harness and model"], ["?", "This sheet"]] },
] as const;

export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

export function isCommandEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
}
