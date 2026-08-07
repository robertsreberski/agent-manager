/**
 * Reads the compatibility wrapper Codex uses when a proposed plan is delivered
 * as a final assistant message instead of a structured `plan` item.
 *
 * The wrapper must own the entire message. Being deliberately strict prevents
 * ordinary prose that merely mentions the tag from turning into an actionable
 * plan card.
 */
export function parseProposedPlan(text: string): string | null {
  const match = /^\s*<proposed_plan>([\s\S]*?)<\/proposed_plan>\s*$/u.exec(text);
  if (!match) return null;
  const markdown = match[1]?.trim() ?? "";
  if (
    markdown.length === 0
    || /<\/?proposed_plan>/u.test(markdown)
  ) return null;
  return markdown;
}
