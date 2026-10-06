/**
 * `@tack/agent-claude`: the Claude Agent SDK as a delegated agent runtime.
 *
 * A plain DSH `SubagentProvider` (default name `claude`). Claude runs its own
 * loop and tools in the delegating session's workspace; this provider decides
 * its permissions (asking the host's approval service when the tier says so),
 * publishes its activity as run events, and returns a structured result when
 * the caller passes an output schema. Agent SDK types never leave this package.
 */
import { join } from "node:path";
import { resolveChildCwd, type SubagentProvider, type SubagentRun, type SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { effectiveTier, type PermissionTier } from "./permissions.js";
import { startRun } from "./run.js";

export const name = "tack-agent-claude";
export const inject = ["subagents", "subprocess", "approval", "credentials"];

export interface AgentClaudeConfig {
  /** Registered provider name, the value a `delegate` agent entry points at. */
  providerName?: string;
  /** Claude model; the SDK default when omitted. */
  model?: string;
  /** What Claude may do without asking: `read-only`, `edit` (default; edits inside the workspace, asks for the rest), or `full`. */
  permissions?: PermissionTier;
  /** What an ask resolves to when no one can answer it (headless runs): `deny` (default) or `allow`. */
  whenNoApprover?: "deny" | "allow";
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Credential reference holding the Anthropic API key; empty to rely on the environment or `configDir`'s own login. */
  apiKeyRef?: string;
  /** Anthropic API base URL (a gateway); the SDK default when omitted. */
  baseUrl?: string;
  /** Extra child environment, applied last. */
  env?: Record<string, string>;
  /** Claude's own configuration directory; default `<Tack home>/claude`, never the user's `~/.claude`. */
  configDir?: string;
  disposeGraceMs?: number;
}

type Resolved = Required<Omit<AgentClaudeConfig, "model" | "maxBudgetUsd" | "baseUrl">> & Pick<AgentClaudeConfig, "model" | "maxBudgetUsd" | "baseUrl">;

const TIERS: readonly PermissionTier[] = ["read-only", "edit", "full"];
/**
 * Parent variables that would configure or authenticate Claude behind the
 * provider's back (an ambient OAuth token or gateway would win over the
 * configured key). Claude's configuration comes only from this row's config.
 */
const AMBIENT_CLAUDE_ENV = /^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/;
/** Claude's own background traffic (telemetry, update checks) is off unless `env` turns it back on. */
const QUIET_ENV = { DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };

type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
interface ProviderContext {
  subagents: { registerProvider(provider: SubagentProvider): void };
  subprocess: { spawn(spec: SubprocessSpawnSpec): SubprocessHandle };
  approval: { request(req: { agent: SubagentStartRequest["parent"]; toolName: string; reason?: string; signal?: AbortSignal }): Promise<ApprovalOutcome> };
  credentials: { resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined> };
  logger: { warn(message: string, ...args: unknown[]): void };
  /** Reads a service when present; the sandbox policy caps Claude's tier by the session's mode. */
  get(name: "sandboxPolicy"): { resolve(request: { session: SubagentStartRequest["parent"]["session"] }): { mode: string } } | undefined;
}

/**
 * An ask the approval service refused to pose. Outside an open turn (a
 * background delegation) nobody can answer, which is `unavailable`, so
 * `whenNoApprover` decides; any other failure denies.
 */
export function unansweredAsk(error: unknown): ApprovalOutcome {
  return error instanceof Error && /outside an open turn/.test(error.message) ? "unavailable" : "rejected";
}

export function resolveConfig(config: AgentClaudeConfig = {}): Resolved {
  const permissions = config.permissions ?? "edit";
  if (!TIERS.includes(permissions)) throw new Error(`agent-claude: permissions must be one of ${TIERS.join(", ")}`);
  const whenNoApprover = config.whenNoApprover ?? "deny";
  if (whenNoApprover !== "deny" && whenNoApprover !== "allow") throw new Error("agent-claude: whenNoApprover must be deny or allow");
  const maxTurns = config.maxTurns ?? 50;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("agent-claude: maxTurns must be a positive integer");
  if (config.maxBudgetUsd !== undefined && !(config.maxBudgetUsd > 0)) throw new Error("agent-claude: maxBudgetUsd must be positive");
  const disposeGraceMs = config.disposeGraceMs ?? 3_000;
  if (!(disposeGraceMs > 0 && disposeGraceMs <= 60_000)) throw new Error("agent-claude: disposeGraceMs must be between 1 and 60000");
  return {
    providerName: config.providerName ?? "claude",
    permissions,
    whenNoApprover,
    maxTurns,
    apiKeyRef: config.apiKeyRef ?? "ANTHROPIC_API_KEY",
    env: config.env ?? {},
    configDir: config.configDir ?? join(resolveDshHome(), "claude"),
    disposeGraceMs,
    ...(config.model !== undefined && { model: config.model }),
    ...(config.maxBudgetUsd !== undefined && { maxBudgetUsd: config.maxBudgetUsd }),
    ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
  };
}

class ClaudeProvider implements SubagentProvider {
  readonly capabilities = { agentOptions: false, outputSchema: true, depthLimit: false, toolFilter: false, persona: false };
  readonly inheritsParentContext = false;

  constructor(
    readonly name: string,
    private readonly ctx: ProviderContext,
    private readonly config: Resolved,
  ) {}

  private async environment(): Promise<Record<string, string | undefined>> {
    const inherited = Object.entries(scrubbedParentEnv()).filter(([name]) => !AMBIENT_CLAUDE_ENV.test(name));
    const env: Record<string, string | undefined> = { ...Object.fromEntries(inherited), ...QUIET_ENV, CLAUDE_CONFIG_DIR: this.config.configDir };
    if (this.config.apiKeyRef !== "") {
      const key = await this.ctx.credentials.resolve(credentialRef(this.config.apiKeyRef));
      if (key === undefined) {
        throw new Error(`agent-claude: no Anthropic key; set it with \`tack auth set ${this.config.apiKeyRef}\` or export ${this.config.apiKeyRef}`);
      }
      env.ANTHROPIC_API_KEY = key.value;
    }
    if (this.config.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = this.config.baseUrl;
    return { ...env, ...this.config.env };
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const cwd = resolveChildCwd("agent-claude", undefined, request.parent.session.header.cwd);
    const env = await this.environment();
    const sandboxMode = this.ctx.get("sandboxPolicy")?.resolve({ session: request.parent.session }).mode;
    const { tier, allowAsks } = effectiveTier(this.config.permissions, sandboxMode);
    const toolPrefix = this.name;
    return startRun(request, {
      cwd,
      env,
      permissions: tier,
      maxTurns: this.config.maxTurns,
      disposeGraceMs: this.config.disposeGraceMs,
      ...(this.config.model !== undefined && { model: this.config.model }),
      ...(this.config.maxBudgetUsd !== undefined && { maxBudgetUsd: this.config.maxBudgetUsd }),
      spawn: (spec) => this.ctx.subprocess.spawn(spec),
      approve: async (toolName, reason, signal) => {
        if (allowAsks) return true;
        const outcome = await this.ctx.approval
          .request({ agent: request.parent, toolName: `${toolPrefix}.${toolName}`, reason, signal })
          .catch((error: unknown) => unansweredAsk(error));
        return outcome === "allowed-once" || (outcome === "unavailable" && this.config.whenNoApprover === "allow");
      },
      onError: (error, stopReason) => this.ctx.logger.warn(`agent-claude "${this.name}": run failed (${stopReason}): %o`, error),
    });
  }
}

export function apply(ctx: ProviderContext, config: AgentClaudeConfig): void {
  const resolved = resolveConfig(config);
  ctx.subagents.registerProvider(new ClaudeProvider(resolved.providerName, ctx, resolved));
}
