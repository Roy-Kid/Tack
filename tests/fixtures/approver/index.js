/**
 * Answers `approval/request` for tools under `config.prefix` (a delegated
 * runtime's tools) with `TACK_TEST_APPROVAL` (default `allowed-once`), and
 * appends each request to `TACK_TEST_APPROVALS_LOG` as one JSON line.
 * Every other request passes to the next answerer.
 */
import { appendFileSync } from "node:fs";

export const name = "tack-test-approver";

export function apply(ctx, config) {
  const prefix = config?.prefix ?? "claude.";
  ctx.on("approval/request", async (req, next) => {
    if (!req.toolName.startsWith(prefix)) return next();
    const outcome = process.env.TACK_TEST_APPROVAL ?? "allowed-once";
    const log = process.env.TACK_TEST_APPROVALS_LOG;
    if (log) appendFileSync(log, `${JSON.stringify({ toolName: req.toolName, reason: req.reason ?? null, outcome })}\n`);
    return outcome;
  });
}
