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
