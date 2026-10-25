import { describe, expect, it } from "vitest";
import { countRpc, forceReleaseRpc, listLeasesRpc } from "./rpc";

describe("rpc definitions", () => {
  it("load, which proves the SDK accepts their names", () => {
    expect([listLeasesRpc.name, countRpc.name, forceReleaseRpc.name]).toEqual(["leases.list", "leases.count", "leases.force-release"]);
  });
});
