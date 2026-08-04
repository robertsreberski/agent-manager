import { useLayoutEffect, useMemo, useRef } from "react";
import type { CockpitSessionView } from "../../lib/cockpit-view";
import {
  buildBoard,
  type BoardModel,
  type BoardOrderState,
  type BoardScope,
} from "./model";

export interface UseBoardModelOptions {
  scope?: BoardScope;
  hostIds?: ReadonlySet<string>;
}

/** Retains only the order from the last board React actually committed. */
export function useBoardModel(
  sessions: readonly CockpitSessionView[],
  options: UseBoardModelOptions = {},
): BoardModel {
  const previousOrder = useRef<BoardOrderState | undefined>(undefined);
  const board = useMemo(() => buildBoard(sessions, {
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.hostIds ? { hostIds: options.hostIds } : {}),
    ...(previousOrder.current ? { previousOrder: previousOrder.current } : {}),
  }), [options.hostIds, options.scope, sessions]);

  useLayoutEffect(() => {
    previousOrder.current = board.order;
  }, [board.order]);

  return board;
}
