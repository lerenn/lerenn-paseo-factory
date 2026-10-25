import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { countRpc } from "../../shared/inbox/rpc";

export { InboxScreen } from "./screen";

/** Unread inbox items, for the Factory's sidebar badge. 0 when the module is off. */
export function useInboxCount(): number {
  const count = useRpc(countRpc);
  const query = useQuery({ queryKey: ["inbox", "count"], queryFn: () => count({}).catch(() => ({ unread: 0, pending: 0 })), refetchInterval: 10_000 });
  return query.data?.unread ?? 0;
}
