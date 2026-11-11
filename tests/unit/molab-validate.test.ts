/**
 * The worker-turn gate's check runs `molab validate --new-only --json`. A
 * stand-in `molab` script proves the arguments, that a non-zero exit with a
 * report still yields its rows, and that no report is an error.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { validateNewOnly } from "../../packages/research/src/molab/validate.js";

function fakeMolab(script: string): { bin: string; args: string } {
  const dir = mkdtempSync(join(tmpdir(), "tack-molab-"));
  const bin = join(dir, "molab");
  const args = join(dir, "args");
  writeFileSync(bin, `#!/bin/sh\necho "$@" > ${JSON.stringify(args)}\n${script}\n`);
  chmodSync(bin, 0o755);
  return { bin, args };
}

describe("validateNewOnly", () => {
  it("runs molab validate --new-only --json on the root and returns every row, even when molab exits non-zero", async () => {
    const row = { path: "experiments/x/assets/a-2", rule: "asset.ambiguous_title", detail: "d", severity: "error", hint: "h" };
    const { bin, args } = fakeMolab(`echo '${JSON.stringify({ root: "/ws", violations: [row] })}'\nexit 1`);
    expect(await validateNewOnly("/ws", undefined, bin)).toEqual([row]);
    expect(readFileSync(args, "utf8").trim()).toBe("validate --workspace /ws --new-only --json");
  });

  it("fails when molab prints no report", async () => {
    const { bin } = fakeMolab(`echo "no workspace here" >&2\nexit 2`);
    await expect(validateNewOnly("/ws", undefined, bin)).rejects.toThrow(/printed no report.*no workspace here/s);
  });
});
