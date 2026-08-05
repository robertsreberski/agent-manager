/**
 * The `@mention` and `/command` affordances the composer placeholder promises.
 *
 * Frame 5a's placeholder reads "@mention files, run /commands". It shipped as
 * "Message the agent…" because neither affordance existed and a placeholder
 * that advertises a control nobody built is worse than a plain one. These are
 * the parsing rules behind the real thing.
 */

export interface CompletionTrigger {
  kind: "file" | "command";
  /** Index of the `@` or `/` itself. */
  start: number;
  /** Text typed after the sigil, which is what gets matched. */
  query: string;
}

/** A `/` only opens the command list at the very start of the message. */
function isCommandPosition(value: string, index: number): boolean {
  return value.slice(0, index).trim().length === 0;
}

/**
 * Which completion, if any, the caret is currently inside.
 *
 * Only a sigil that begins a word counts, so an email address or a path in the
 * middle of a sentence never opens the picker. A space closes it: whatever the
 * operator went on to type is prose, not a query.
 */
export function completionTrigger(value: string, caret: number): CompletionTrigger | null {
  const upToCaret = value.slice(0, caret);
  for (let index = upToCaret.length - 1; index >= 0; index -= 1) {
    const character = upToCaret[index]!;
    if (/\s/u.test(character)) return null;
    if (character !== "@" && character !== "/") continue;
    const preceding = index === 0 ? "" : upToCaret[index - 1]!;
    const beginsWord = preceding === "" || /\s/u.test(preceding);
    if (!beginsWord) {
      // A separator inside a path — `src/app` — is not a sigil, so keep
      // walking back for the `@` that opened it. A mid-word `@` is an address.
      if (character === "/") continue;
      return null;
    }
    const query = upToCaret.slice(index + 1);
    if (character === "@") return { kind: "file", start: index, query };
    return isCommandPosition(value, index) ? { kind: "command", start: index, query } : null;
  }
  return null;
}

/** Replaces the trigger and its query with the chosen completion. */
export function applyCompletion(
  value: string,
  caret: number,
  trigger: CompletionTrigger,
  choice: string,
): { value: string; caret: number } {
  const sigil = trigger.kind === "file" ? "@" : "/";
  const inserted = `${sigil}${choice} `;
  const next = value.slice(0, trigger.start) + inserted + value.slice(caret);
  return { value: next, caret: trigger.start + inserted.length };
}

export interface ProviderCommand {
  name: string;
  description: string;
}

/*
  Only commands the provider's own CLI actually accepts. A cockpit-invented
  command would send text the harness does not understand, and the placeholder
  would be lying again in a way that costs the operator a turn.
*/
const CLAUDE_COMMANDS: readonly ProviderCommand[] = [
  { name: "clear", description: "Clear the conversation history" },
  { name: "compact", description: "Summarise the conversation to free context" },
  { name: "context", description: "Show what is currently in context" },
  { name: "cost", description: "Show token spend for this session" },
  { name: "init", description: "Write a CLAUDE.md for this repository" },
  { name: "review", description: "Review a pull request" },
  { name: "security-review", description: "Review the branch for vulnerabilities" },
];

const CODEX_COMMANDS: readonly ProviderCommand[] = [
  { name: "compact", description: "Summarise the conversation to free context" },
  { name: "diff", description: "Show the working-tree diff" },
  { name: "init", description: "Write an AGENTS.md for this repository" },
  { name: "review", description: "Review the current changes" },
  { name: "status", description: "Show session and token status" },
];

export function providerCommands(provider: string): readonly ProviderCommand[] {
  if (provider === "claude") return CLAUDE_COMMANDS;
  if (provider === "codex") return CODEX_COMMANDS;
  // A provider whose command set is unknown offers none, and the composer
  // drops that half of the placeholder rather than promising it.
  return [];
}

export function matchCommands(provider: string, query: string): readonly ProviderCommand[] {
  const needle = query.trim().toLowerCase();
  return providerCommands(provider)
    .filter((command) => command.name.startsWith(needle))
    .slice(0, 8);
}

/** The placeholder frame 5a asks for, reduced to whatever actually exists. */
export function composerPlaceholder(provider: string, canMentionFiles: boolean): string {
  const affordances = [
    canMentionFiles ? "@mention files" : null,
    providerCommands(provider).length > 0 ? "run /commands" : null,
  ].filter((affordance): affordance is string => affordance !== null);
  return affordances.length > 0 ? `${affordances.join(", ")}…` : "Message the agent…";
}
