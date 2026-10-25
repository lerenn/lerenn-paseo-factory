import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { countRpc } from "../../shared/leases/rpc";

export { LeasesScreen } from "./screen";

/** Waiting lease requests, for the Factory's sidebar badge. 0 when the module is off. */
export function useLeasesWaiting(): number {
  const count = useRpc(countRpc);
  const query = useQuery({ queryKey: ["leases", "count"], queryFn: () => count({}).catch(() => ({ held: 0, waiting: 0 })), refetchInterval: 10_000 });
  return query.data?.waiting ?? 0;
}
