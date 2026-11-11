/**
 * `@tack/codex`: Codex as a DSH subagent provider, over the official
 * app-server protocol of the Codex release this package depends on.
 *
 * It registers provider `codex` on `ctx.subagents`, so DSH's own
 * `subagent_codex` tool, its job list and its UI run Codex through it. It
 * replaces `@deepseek-ai/dsh-subagent-codex`, which pins an old Codex client
 * that current accounts' models refuse and reports failures as bare
 * categories.
 *
 * @module @tack/codex
 */
import type { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import { NO_START_CAPABILITIES, assertUsableCwd, type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentRun } from "@deepseek-ai/dsh-subagent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordTarget } from "./record.js";
import { CODEX_VERSION, startCodexRun, type RunSpec } from "./run.js";
import { PERMISSION_MODES, type PermissionMode } from "./wire.js";

export const name = "tack-codex";
export const inject = ["subagents", "subprocess"];

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

const ConfigSchema = z
  .object({
    /** Provider name on `ctx.subagents`. */
    providerName: z.string().min(1).default("codex"),
    /** Codex model; omitted, the account's Codex default applies. */
    model: z.string().min(1).optional(),
    /** Reasoning effort; omitted, Codex's configured effort applies. */
    effort: z.enum(EFFORTS).optional(),
    /**
     * never: Codex's own sandbox, no approvals. approve-for-me: workspace
     * writes, escalations auto-reviewed. dangerously-bypass-approvals-and-sandbox: no limits.
     */
    permissionMode: z.enum(Object.keys(PERMISSION_MODES) as [PermissionMode, ...PermissionMode[]]).default("never"),
    /** Entries layered over the subprocess service's scrubbed environment. */
    env: z.record(z.string(), z.string()).default({}),
    /** Grace in milliseconds between termination signals at teardown. */
    disposeGraceMs: z.number().positive().max(60_000).default(3000),
    /**
     * Directory for one JSONL record per run: the task, the model, and every
     * command Codex ran and file it changed. Omitted, a run inside a molab
     * workspace is recorded in `<workspace>/.molab/agents/codex/`, and any
     * other run is persisted by Codex in its own session store.
     */
    activityDir: z.string().min(1).optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/** Validate a row config; the error names every bad field. */
export function parseConfig(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`tack-codex: invalid config: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

class CodexProvider implements SubagentProvider {
  readonly capabilities = { ...NO_START_CAPABILITIES, outputSchema: true };
  readonly inheritsParentContext = false;
  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /** One JSONL file per run in `dir`; a failure to write it is logged, never fatal. */
  private recordActivity(dir: string, cwd: string, summary: Parameters<RunSpec["report"]>[0]): void {
    const lines = [
      {
        event: "run",
        at: new Date().toISOString(),
        codex: CODEX_VERSION,
        provider: this.name,
        cwd,
        task: summary.task,
        model: summary.model,
        stopReason: summary.stopReason,
        diagnostic: summary.diagnostic,
        usage: summary.usage?.total,
        untrustedHooks: summary.untrustedHooks,
      },
      ...summary.activity.map((entry) => ({ event: entry.kind, ...entry })),
    ];
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${summary.runId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    } catch (error) {
      this.ctx.logger.warn(`codex "${this.name}": could not write the activity log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const cwd = assertUsableCwd("codex", "child cwd", request.cwd);
    const target = recordTarget(cwd, this.config.activityDir);
    return startCodexRun(request, {
      cwd,
      ephemeral: target.kind === "directory",
      ...(this.config.model !== undefined && { model: this.config.model }),
      ...(this.config.effort !== undefined && { effort: this.config.effort }),
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: (spec) => this.ctx.subprocess.spawn(spec),
      report: (summary) => {
        const { stopReason, model, usage, diagnostic, untrustedHooks } = summary;
        if (untrustedHooks.length > 0) {
          this.ctx.logger.warn(`codex "${this.name}": Codex skipped ${untrustedHooks.length} untrusted hook(s), so they checked nothing: ${untrustedHooks.join(", ")}`);
        }
        if (target.kind === "directory") this.recordActivity(target.dir, cwd, summary);
        const tokens = usage === undefined ? "" : `; tokens in ${usage.total.inputTokens} (cached ${usage.total.cachedInputTokens}), out ${usage.total.outputTokens}`;
        const line = `codex ${CODEX_VERSION} "${this.name}": ${stopReason}${model ? ` (model ${model})` : ""}${tokens}`;
        if (stopReason === "completed") this.ctx.logger.info(line);
        else this.ctx.logger.warn(`${line}${diagnostic ? `: ${diagnostic}` : ""}`);
      },
    });
  }
}

export function apply(ctx: Context, rawConfig: unknown): void {
  const config = parseConfig(rawConfig);
  ctx.subagents.registerProvider(new CodexProvider(config.providerName, ctx, config));
}
