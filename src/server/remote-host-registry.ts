import {
  addSshHost,
  defaultPaths,
  loadConfig,
  mutateConfig,
  removeSshHost,
  type AgentManagerPaths,
  type ConfigLockOptions,
  type SshHostConfig,
} from "../ops/config.ts";
import type { RemoteHostDefinition } from "../remote/manager.ts";

export interface RemoteHostRegistry {
  list(): RemoteHostDefinition[];
  add(input: { label: string; target: string }): RemoteHostDefinition;
  remove(id: string): boolean;
}

export const REMOTE_HOST_REGISTRY_LOCK_TIMEOUT_MS = 500;

function definition(host: SshHostConfig): RemoteHostDefinition {
  return { id: host.id, label: host.name, target: host.target };
}

/**
 * The owner config is the canonical remote-host registry. Every read reloads
 * it, while writes use its locked reload-mutate-save transaction so a browser
 * request cannot overwrite a concurrent CLI edit.
 */
export class ConfigRemoteHostRegistry implements RemoteHostRegistry {
  readonly #paths: AgentManagerPaths;
  readonly #lockOptions: ConfigLockOptions;

  constructor(
    paths: AgentManagerPaths = defaultPaths(),
    lockOptions: ConfigLockOptions = {},
  ) {
    this.#paths = paths;
    this.#lockOptions = {
      timeoutMs: REMOTE_HOST_REGISTRY_LOCK_TIMEOUT_MS,
      ...lockOptions,
    };
  }

  list(): RemoteHostDefinition[] {
    return loadConfig(this.#paths).hosts.map(definition);
  }

  add(input: { label: string; target: string }): RemoteHostDefinition {
    const host = mutateConfig(
      (config) => addSshHost(config, { name: input.label, target: input.target }),
      this.#paths,
      this.#lockOptions,
    );
    return definition(host);
  }

  remove(id: string): boolean {
    return mutateConfig(
      (config) => removeSshHost(config, id),
      this.#paths,
      this.#lockOptions,
    );
  }
}
