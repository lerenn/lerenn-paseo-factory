import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { needsAttentionBadge } from "./attention";
import { listRunsRpc } from "../../shared/blueprints/rpc";

export { BlueprintsScreen } from "./screen";
export { CronsScreen } from "./crons";

/** Runs waiting for the PM or a person, for the Factory's sidebar badge. 0 when the module is off. */
export function useRunsNeedingAttention(): number {
  const list = useRpc(listRunsRpc);
  const query = useQuery({
    queryKey: ["blueprints", "attention"],
    queryFn: () => list({ includeFinished: false }).catch(() => null),
    refetchInterval: 10_000,
  });
  return query.data?.runs.filter(needsAttentionBadge).length ?? 0;
}
