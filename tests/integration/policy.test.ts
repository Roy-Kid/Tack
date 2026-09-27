/**
 * Tack's product policy, enforced from the reviewed runtime closure: every
 * mounted row whose package Tack decided to disable is disabled in every Tack
 * profile, and DeepSeek stays the default (switchable) provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { rmSync } from "node:fs";
import { readClosureFile } from "../../scripts/runtime-closure.ts";
import { parseDumpRows, spawnTack, tempHome, type DumpRow } from "../helpers.js";

const closure = readClosureFile();
const disabledPackages = new Set(
  Object.entries(closure.packages)
    .filter(([, review]) => review.decision === "disable")
    .map(([name]) => name),
);

let home: string;
const dumps = new Map<string, { rows: DumpRow[]; stderr: string }>();

beforeAll(async () => {
  home = tempHome();
  for (const profile of ["default", "web"]) {
    const result = await spawnTack(["doctor", "--dump-config", "--profile", profile], { home });
    expect(result.code).toBe(0);
    dumps.set(profile, { rows: parseDumpRows(result.stdout), stderr: result.stderr });
  }
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.each(["default", "web"])("profile %s", (profile) => {
  it("composes without patch warnings", () => {
    expect(dumps.get(profile)!.stderr.trim()).toBe("");
  });

  it("disables every row whose package Tack decided to disable", () => {
    const offending = dumps
      .get(profile)!
      .rows.filter((row) => row.name !== undefined && disabledPackages.has(row.name.split("/").slice(0, 2).join("/")))
      .filter((row) => row.disabled !== "true")
      .map((row) => `${row.id} (${row.name})`);
    expect(offending).toEqual([]);
  });

  it("keeps DeepSeek as the default provider", () => {
    const row = dumps.get(profile)!.rows.find((candidate) => candidate.id === "agent-default-model");
    expect(row?.lines).toContain("    provider: deepseek-official");
  });
});
