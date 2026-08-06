import {
  reasoningEffortsForProvider,
  type Provider,
  type ReasoningEffort,
} from "../../../src/shared/session.ts";

/**
 * The effort levels a composer may offer, for a draft and a live session alike.
 *
 * Three distinct cases, and conflating any two of them hides the control:
 *
 * - `undefined` — the catalog has not loaded. Offer nothing; a guess made
 *   before the provider has answered is not an offer, it is a fabrication.
 * - a non-empty catalog — the provider has named the levels. Use exactly those.
 * - an empty loaded catalog — the provider named none that every row agrees on,
 *   but the harness has still granted the write. A granted `set-effort` is the
 *   harness's own claim that a level drawn from its provider vocabulary will be
 *   accepted, so that vocabulary is the honest offer.
 *
 * A draft passes `canSetEffort: true`: effort is a field of the create request,
 * so a session that does not exist yet cannot have refused it.
 */
export function composerEffortOptions(
  provider: Provider | null,
  catalogEfforts: readonly ReasoningEffort[] | undefined,
  canSetEffort: boolean,
): readonly ReasoningEffort[] {
  if (catalogEfforts === undefined) return [];
  if (catalogEfforts.length > 0) return catalogEfforts;
  if (!canSetEffort || provider === null) return [];
  return reasoningEffortsForProvider(provider);
}

/**
 * The catalog row that covers a session's model: an exact `value` match, or
 * the alias row whose `resolvedModel` names the same wire id. A session's
 * model is reported by the provider as a wire id, while catalogs list alias
 * rows, so exact equality alone misses the row the session is actually on.
 *
 * A null model means the provider's default is in force, so the row the
 * catalog itself marks default covers it — a claim the catalog makes, unlike
 * "the first row", which is only an accident of ordering.
 */
export function coveringModelOption<
  T extends {
    value: string;
    resolvedModel?: string | undefined;
    isDefault?: boolean | undefined;
  },
>(model: string | null, options: readonly T[]): T | null {
  if (model === null) {
    return options.find((option) => option.isDefault === true) ?? null;
  }
  return options.find((option) => option.value === model)
    ?? options.find((option) => option.resolvedModel === model)
    ?? null;
}
