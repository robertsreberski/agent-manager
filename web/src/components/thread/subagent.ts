import type {
  ActivityFileChangeItem,
  ActivityItem,
  ActivitySubagentItem,
  ActivityUsageItem,
} from "../../types";

export interface SubagentReturnFacts {
  additions: number | null;
  removals: number | null;
  tokens: number | null;
  costUsd: number | null;
}

/**
 * Data carried by the assistant-ui data part for one visible subagent. The
 * activity items remain authoritative; this view only records their exact
 * hierarchy and the facts that can be derived from retained children.
 */
export interface SubagentFrameData {
  item: ActivitySubagentItem;
  steps: ActivityItem[];
  nestedCount: number;
  returnFacts: SubagentReturnFacts;
}

export interface SubagentHierarchy {
  topLevelItems: ActivityItem[];
  frames: ReadonlyMap<string, SubagentFrameData>;
}

function ordered<T extends ActivityItem>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

function diffFacts(items: readonly ActivityItem[]): Pick<SubagentReturnFacts, "additions" | "removals"> {
  const files = items.filter((item): item is ActivityFileChangeItem => item.kind === "file-change");
  if (files.length === 0) return { additions: null, removals: null };

  // A provider aggregate supersedes its per-tool fragments. Without one, de-dupe
  // byte-identical changes so a provider update cannot inflate the return facts.
  const aggregates = files.filter((item) => item.summary === "Turn diff");
  const selected = aggregates.length > 0 ? [ordered(aggregates).at(-1)!] : files;
  const seen = new Set<string>();
  let additions = 0;
  let removals = 0;
  for (const item of selected) {
    for (const change of item.changes) {
      const key = `${change.path}\0${change.operation}\0${change.diff}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const line of change.diff.split(/\r?\n/u)) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
        if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
      }
    }
  }
  return { additions, removals };
}

function usageFacts(items: readonly ActivityItem[]): Pick<SubagentReturnFacts, "tokens" | "costUsd"> {
  const usage = ordered(items.filter((item): item is ActivityUsageItem => item.kind === "usage")).at(-1);
  return {
    tokens: usage?.totalTokens ?? null,
    costUsd: usage?.costUsd ?? null,
  };
}

/**
 * Projects the retained activity graph into exactly one visible subagent
 * level. parentId is preferred; childItemIds supplies the edge when a provider
 * cannot put it on the child. Descendant subagents and their steps stay hidden
 * behind a count instead of creating a third indentation level.
 */
export function buildSubagentHierarchy(items: readonly ActivityItem[]): SubagentHierarchy {
  const sorted = ordered(items);
  const byId = new Map(sorted.map((item) => [item.id, item]));
  const declaredParent = new Map<string, string>();
  for (const item of sorted) {
    if (item.kind !== "subagent") continue;
    for (const childId of item.childItemIds) {
      if (byId.has(childId) && !declaredParent.has(childId)) declaredParent.set(childId, item.id);
    }
  }

  const parent = (item: ActivityItem): ActivityItem | null => {
    if (item.parentId) {
      const explicit = byId.get(item.parentId);
      if (explicit) return explicit;
    }
    const fallback = declaredParent.get(item.id);
    return fallback ? byId.get(fallback) ?? null : null;
  };

  const subagentAncestors = (item: ActivityItem): ActivitySubagentItem[] => {
    const ancestors: ActivitySubagentItem[] = [];
    const seen = new Set<string>([item.id]);
    let cursor = parent(item);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.kind === "subagent") ancestors.push(cursor);
      cursor = parent(cursor);
    }
    return ancestors;
  };

  const canonicalRoots = sorted.filter((item): item is ActivitySubagentItem => (
    item.kind === "subagent" && subagentAncestors(item).length === 0
  ));
  const rootIds = new Set(canonicalRoots.map((item) => item.id));
  const owner = new Map<string, ActivitySubagentItem>();
  for (const item of sorted) {
    const ancestors = subagentAncestors(item);
    const root = ancestors.at(-1);
    if (root && rootIds.has(root.id)) owner.set(item.id, root);
  }

  const visibleRoots = sorted.filter((item): item is ActivitySubagentItem => (
    item.kind === "subagent" && !owner.has(item.id)
  ));
  const frames = new Map<string, SubagentFrameData>();
  for (const root of visibleRoots) {
    const descendants = sorted.filter((item) => owner.get(item.id)?.id === root.id);
    const directDescendants = descendants.filter((item) => subagentAncestors(item)[0]?.id === root.id);
    const directSteps = directDescendants.filter((item) => item.kind !== "subagent" && item.kind !== "usage");
    const nestedCount = descendants.filter((item) => item.kind === "subagent").length;
    frames.set(root.id, {
      item: root,
      steps: directSteps,
      nestedCount,
      returnFacts: {
        ...diffFacts(descendants),
        ...usageFacts(directDescendants),
      },
    });
  }

  return {
    topLevelItems: sorted.filter((item) => !owner.has(item.id)),
    frames,
  };
}
