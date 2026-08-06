import {
  CONTROL_CAPABILITIES,
  type ControlCapability,
  type SessionControl,
} from "../../shared/session.ts";

/*
  Both managed adapters answer the same question for every control: may the
  cockpit use it, and if not, what does the operator get told? They answered it
  in two different encodings — one inline literal, one pair of constant arrays —
  and nothing connected the two lists an adapter published, so a capability
  could be granted and withheld at once, or fall out of both and simply vanish.

  A ruling table answers it once per capability. The two published lists are
  derived, so they cannot disagree, and `Record<ControlCapability, …>` makes a
  capability nobody ruled on a compile error rather than a silent omission.
*/

/**
 * A capability this adapter deliberately does not rule on, because a layer
 * above it decides: `open-editor` belongs to the server's editor launcher,
 * `take-control` and `cancel-take-control` to the CLI takeover coordinator, and
 * `preview` to tmux.
 *
 * Deferring is not withholding, and the difference is load-bearing.
 * `withLocalEditorCapability` treats a withheld `open-editor` as a standing
 * refusal and will not grant the capability afterwards, so an adapter that
 * "honestly" withheld it would remove the editor button from every managed
 * session. A deferred capability appears in neither published list, leaving the
 * decision where it actually lives.
 */
export const DEFERRED = Symbol("capability deferred to a later layer");

/** Granted, withheld with a reason the operator reads, or deferred. */
export type CapabilityRuling = true | string | typeof DEFERRED;

/** One ruling per capability. Omitting any is a compile error. */
export type CapabilityRulings = Readonly<Record<ControlCapability, CapabilityRuling>>;

/**
 * Split one ruling table into the capability and withheld lists a session view
 * publishes.
 *
 * Publication order is `CONTROL_CAPABILITIES` order, so a view's capability
 * order is a property of the vocabulary rather than of the order an adapter
 * happened to push in. Disjointness is structural: one ruling per capability
 * means a capability cannot reach both lists.
 */
export function resolveControlCapabilities(
  rulings: CapabilityRulings,
): Pick<SessionControl, "capabilities" | "withheld"> {
  const capabilities: ControlCapability[] = [];
  const withheld: SessionControl["withheld"] = [];
  for (const capability of CONTROL_CAPABILITIES) {
    const ruling = rulings[capability];
    if (ruling === DEFERRED) continue;
    if (ruling === true) {
      capabilities.push(capability);
      continue;
    }
    // A withheld capability the operator cannot act on still owes them the
    // reason, so an empty one is a bug in the caller rather than a valid state.
    if (typeof ruling !== "string" || ruling.trim().length === 0) {
      throw new Error(`Withheld capability ${capability} needs a reason`);
    }
    withheld.push({ capability, reason: ruling });
  }
  return { capabilities, withheld };
}

/**
 * Every capability set to one ruling, to spread and then override. Useful for
 * the states where an adapter has nothing to offer yet and one sentence
 * explains all of them.
 */
export function allCapabilities(ruling: CapabilityRuling): Record<ControlCapability, CapabilityRuling> {
  return Object.fromEntries(
    CONTROL_CAPABILITIES.map((capability) => [capability, ruling]),
  ) as Record<ControlCapability, CapabilityRuling>;
}

/**
 * The capabilities no managed provider adapter rules on, because the server
 * and its coordinators decide them after the adapter has published a view.
 */
export function deferredToLaterLayers(): Pick<
  Record<ControlCapability, CapabilityRuling>,
  "preview" | "take-control" | "cancel-take-control" | "retry-control" | "open-editor"
> {
  return {
    preview: DEFERRED,
    "take-control": DEFERRED,
    "cancel-take-control": DEFERRED,
    "retry-control": DEFERRED,
    "open-editor": DEFERRED,
  };
}
