/** Shown to agents through the MCP `instructions` field of the initialize result. */
export const INSTRUCTIONS = `Agents Leases makes sure only one agent at a time works on a shared resource (a PR, a QA environment, anything with a name you agree on).

How it works: a lease is a name held by one agent for a TTL (seconds). Take it with lease_acquire before touching the resource, keep the returned token, renew before it expires and release it when done. A lease that is not renewed expires. The token is a handover counter: it changes every time the lease changes holder, and renew or release with an old token are refused, which tells you that you lost the lease.

Modes of lease_acquire:
- queue (default): if someone else holds the lease you are queued, status is "queued". END YOUR TURN: when the lease is yours you are woken with a message starting with "Agents Leases:" that carries your token. Do not poll or work on the resource meanwhile.
- takeover (newest wins): you take the lease at once and the previous holder is told it lost it. Use it when the newest request supersedes the older one.

If you receive a message saying you lost a lease (taken over by another agent, handed to a waiter, released by a human), stop working on that resource immediately; do not renew or release it. A lease that only expired with nobody else holding it is different: its message (and a refused renew) says nobody else holds it, and if the work is still yours you take it again with lease_acquire (mode queue) and carry on. If that acquire queues you, someone else has it: leave the queue and stop.

Tools:
- lease_acquire(name, ttl, mode?): ttl in seconds. Returns status "held" with token and expires_at, or "queued" with your position. Calling it again for a lease you hold renews it.
- lease_renew(name, token, ttl?): extends your lease by its TTL (or ttl). Refused if the token is stale.
- lease_release(name, token): gives the lease up; the next waiter gets it. Without token, leaves the waiting queue.
- lease_list(): all leases with holder, mode, expiry and queue.

Leases are released automatically when the holder agent is archived. Which lease names and TTLs to use is up to your instructions; keep names stable, for example "pr:org/repo#123".`;
