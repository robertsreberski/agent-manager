import { emptyChildSummary, type SessionRecord } from "../../shared/session.ts";

/*
  The fields no managed provider session may differ on.

  Both adapters assemble a `SessionRecord` by hand from unrelated provider
  state, and a third of that shape is not provider state at all — it is the same
  set of constants written out twice. Twice is how they drift: one adapter
  gained a field the other did not, and the difference showed up in the cockpit
  rather than in review.

  Only the invariants live here. `presence`, `updatedAt`, `cwd`, lineage,
  `sandbox`, and the control plane stay in each adapter, because each is a
  judgement that adapter makes about its own provider and sharing them would be
  asserting a coincidence.
*/

/** The only host a locally managed provider session can be on. */
export const LOCAL_HOST = Object.freeze({
  hostId: "local",
  hostLabel: "This Mac",
} as const);

type ManagedSessionInvariants = Pick<
  SessionRecord,
  | "hostId"
  | "hostLabel"
  | "kind"
  | "depth"
  | "archived"
  | "terminal"
  | "todoProgress"
  | "statusSource"
  | "childSummary"
>;

/**
 * The invariant half of a managed provider session view.
 *
 * A managed session is always local, always interactive, always a root, never
 * archived at publication, never a tmux pane, and never carries a rollup — it
 * is one conversation this manager owns. Its status always comes from the
 * provider's own API, because that is what being managed means.
 */
export function managedSessionInvariants(): ManagedSessionInvariants {
  return {
    ...LOCAL_HOST,
    kind: "interactive",
    depth: 0,
    archived: false,
    // A managed session is driven through the provider, not a terminal pane.
    terminal: null,
    // Todo rollup is a board-level projection, never a provider fact.
    todoProgress: null,
    statusSource: "provider-api",
    childSummary: emptyChildSummary(),
  };
}
