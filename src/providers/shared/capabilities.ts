/*
  The capability ledger is provider-neutral: it knows only `ControlCapability`,
  and `observeOnlyControl` in the shared vocabulary needs it too. It therefore
  lives in `src/shared`, and this re-export keeps the provider-facing import
  path that adapters already use.
*/
export {
  DEFERRED,
  allCapabilities,
  deferredToLaterLayers,
  resolveControlCapabilities,
  type CapabilityRuling,
  type CapabilityRulings,
} from "../../shared/capabilities.ts";
