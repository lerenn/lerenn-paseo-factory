import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadSchedules, parseEntries, parseSchedulesFile, SCHEDULES_FILE } from "./schedules";

it("reads entries with defaults and leaves bad ones out with the reason", () => {
  const { schedules, errors } = parseEntries(
    [
      { id: "a", cron: "0 9 * * 1-5", blueprint: "bp" },
      { id: "b", cron: "0 9 * *", blueprint: "bp" },
      { id: "a", cron: "* * * * *", blueprint: "bp" },
      { id: "c", cron: "* * * * *", blueprint: "bp", timezone: "Nowhere/City" },
      { id: "d", cron: "* * * * *", blueprint: "bp", vars: { cron_id: "x" } },
      { id: "E", cron: "* * * * *", blueprint: "bp" },
      { id: "f", cron: "* * * * *", blueprint: "bp", vars: { n: 1 } },
    ],
    "src",
  );
  expect(schedules.map((s) => s.id)).toEqual(["a"]);
  expect(schedules[0]).toMatchObject({ timezone: "UTC", vars: {}, enabled: true, maxFailures: 2, source: "src" });
  expect(errors.map((e) => e.split(":")[1]!.trim())).toEqual(["b", "a", "c", "d", "E", "f"]);
  expect(() => parseSchedulesFile("[]")).toThrow(/schedules/);
});

it("loads crons/schedules.json of each git source after the settings, the first id winning, keeping a broken file's last good copy", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "crons-src-"));
  const write = (dir: string, text: string) => {
    mkdirSync(path.join(root, dir, "crons"), { recursive: true });
    writeFileSync(path.join(root, dir, SCHEDULES_FILE), text);
  };
  write("one", JSON.stringify({ schedules: [{ id: "x", cron: "0 9 * * *", blueprint: "bp", timezone: "Europe/Paris" }, { id: "dup", cron: "* * * * *", blueprint: "other" }] }));
  write("two", JSON.stringify({ schedules: [{ id: "y", cron: "0 * * * *", blueprint: "bp" }] }));
  const files = [
    { file: path.join(root, "one", SCHEDULES_FILE), label: "o/one@main:crons/schedules.json" },
    { file: path.join(root, "two", SCHEDULES_FILE), label: "o/two@main:crons/schedules.json" },
    { file: path.join(root, "none", SCHEDULES_FILE), label: "o/none@main:crons/schedules.json" },
  ];
  const lastGood = new Map<string, unknown[]>();
  const first = await loadSchedules(files, [{ id: "dup", cron: "0 0 * * *", blueprint: "mine" }], lastGood);
  expect(first.schedules.map((s) => [s.id, s.blueprint, s.source])).toEqual([
    ["dup", "mine", "settings"],
    ["x", "bp", "o/one@main:crons/schedules.json"],
    ["y", "bp", "o/two@main:crons/schedules.json"],
  ]);
  expect(first.errors).toEqual(["o/one@main:crons/schedules.json: dup: repeated id, only the first counts"]);

  write("two", "{ not json");
  const second = await loadSchedules(files, [], lastGood);
  expect(second.schedules.map((s) => s.id)).toEqual(["x", "dup", "y"]);
  expect(second.errors[0]).toMatch(/^o\/two@main:crons\/schedules.json: .*last good copy is in use/);
});
