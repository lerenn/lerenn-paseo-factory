import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_ROLE_VALUE } from "../shared/role";
import type { RoleEntry } from "../shared/rpc";
import { registerRoleCreateOption, roleOptions, ROLE_REFRESH_MS } from "./create-option";

const entry = (name: string, extra: Partial<RoleEntry> = {}) =>
  ({ name, origin: "o/r@main", text: "", sourceId: "s", overrides: [], role: { name, version: 1 }, ...extra }) as RoleEntry;

describe("role options", () => {
  it("lists No role first, then the valid roles", () => {
    expect(
      roleOptions([entry("reviewer", { role: { name: "reviewer", version: 1, description: "Reviews" } }), entry("broken", { role: undefined, error: "bad" })]),
    ).toEqual([
      { value: NO_ROLE_VALUE, label: "No role" },
      { value: "reviewer", label: "reviewer", description: "Reviews" },
    ]);
  });
});

describe("role create option", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function host(rolesNow: () => RoleEntry[]) {
    const remove = vi.fn();
    const addCreateOption = vi.fn(() => remove);
    const rpc = vi.fn(async () => ({ roles: rolesNow(), git: [] }));
    return { client: { addCreateOption, rpc } as never, addCreateOption, remove, rpc };
  }

  it("registers the picker once the roles load and again when they change", async () => {
    let roles = [entry("reviewer")];
    const { client, addCreateOption, remove } = host(() => roles);
    const stop = registerRoleCreateOption(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(addCreateOption).toHaveBeenCalledTimes(1);
    expect(addCreateOption.mock.calls[0]).toMatchObject([{ id: "role", defaultValue: NO_ROLE_VALUE }]);

    await vi.advanceTimersByTimeAsync(ROLE_REFRESH_MS);
    expect(addCreateOption).toHaveBeenCalledTimes(1);

    roles = [entry("reviewer"), entry("writer")];
    await vi.advanceTimersByTimeAsync(ROLE_REFRESH_MS);
    expect(addCreateOption).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);

    stop();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("shows no picker without roles, and does nothing on a host without create options", async () => {
    const { client, addCreateOption } = host(() => []);
    registerRoleCreateOption(client)();
    await vi.advanceTimersByTimeAsync(0);
    expect(addCreateOption).not.toHaveBeenCalled();

    const old = { rpc: vi.fn() } as never;
    registerRoleCreateOption(old)();
    expect((old as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });
});
