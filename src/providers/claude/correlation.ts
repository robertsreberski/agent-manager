import { messageCorrelationId } from "../../activity/correlation.ts";

/**
 * Canonical identity for one visible Claude assistant message, shared by every
 * surface that reports it: the SDK stream, the hook bridge, and the transcript.
 *
 * Claude has no identifier all three know. The transcript records the Anthropic
 * message id; the hook carries a CLI display UUID the SDK documents as "Not the
 * API msg_… id" and which is never written to the transcript; the SDK stream has
 * the API id but derives its turns from message uuids. So the SDK and transcript
 * used to pair on the API message id while the hook could pair with neither, and
 * every assistant reply on a hook-fed session was stated twice — once live, once
 * from the transcript, in two different turns.
 *
 * The text is the only name all three know, so it is the key.
 *
 * Deliberately not scoped by thread or turn, unlike Codex's equivalent. The three
 * surfaces derive a turn from three different identifiers — `prompt_id`,
 * `promptId`, and an internal message uuid — so narrowing the key by turn would
 * reintroduce exactly the disagreement it is supposed to remove. Correlation is
 * only consulted within one session's items, which is scope enough; two replies
 * with identical text stay distinct because the hub preserves repeated exact
 * occurrences and reconciliation pairs equal cardinalities in order.
 *
 * `text` must be the redacted string the caller is about to publish. The hub
 * redacts on the way in, so a key built from raw text would not match the item
 * that eventually lands.
 */
export function claudeMessageCorrelationId(
  role: "user" | "assistant",
  text: string,
): string {
  return messageCorrelationId("claude", null, null, role, text);
}
