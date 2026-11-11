/**
 * The worker-turn gate's check: `molab validate --new-only --json` over the
 * served workspace. The CLI, not the served route, because only the CLI
 * compares against the workspace's baseline, so errors a turn did not cause
 * do not refuse it.
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import { ValidationRow } from "./schemas.js";

const Report = z.looseObject({ violations: z.array(ValidationRow) });

/** Run `molab validate --new-only --json` on `root`; every violation it reports. */
export function validateNewOnly(root: string, signal?: AbortSignal, molab = "molab"): Promise<ValidationRow[]> {
  return new Promise((resolve, reject) => {
    execFile(molab, ["validate", "--workspace", root, "--new-only", "--json"], { maxBuffer: 64 * 1024 * 1024, ...(signal !== undefined && { signal }) }, (error, stdout, stderr) => {
      // A workspace with errors exits non-zero and still prints its report.
      let parsed: z.ZodSafeParseResult<z.infer<typeof Report>>;
      try {
        parsed = Report.safeParse(JSON.parse(stdout));
      } catch {
        reject(new Error(`molab validate printed no report${error !== null ? ` (${error.message})` : ""}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      if (!parsed.success) {
        reject(new Error(`molab validate printed an unexpected report: ${z.prettifyError(parsed.error)}`));
        return;
      }
      resolve(parsed.data.violations);
    });
  });
}
