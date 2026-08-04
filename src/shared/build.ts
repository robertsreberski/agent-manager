declare const __AGENT_MANAGER_BUILD_ID__: string | undefined;

/**
 * Production builds replace this expression with one content-derived epoch.
 * Direct source execution is the deliberate development/test fallback
 * boundary; built and source-mode nodes are expected to reject each other.
 */
export const AGENT_MANAGER_BUILD_ID =
  typeof __AGENT_MANAGER_BUILD_ID__ === "string"
  && __AGENT_MANAGER_BUILD_ID__.length > 0
  && __AGENT_MANAGER_BUILD_ID__.length <= 128
    ? __AGENT_MANAGER_BUILD_ID__
    : "development";
