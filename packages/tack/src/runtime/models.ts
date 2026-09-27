/**
 * Model, provider, and credential operations over a booted profile's own
 * services (agent default model, LLM router, settings, credentials). Every
 * write goes through the runtime's validated services, never raw YAML.
 * Runtime-facing; only the runtime module imports this file.
 */

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ProviderModels {
  provider: string;
  name: string;
  models: { id: string; name: string }[];
}

/** A provider route Tack can configure through the multi-provider adapter. */
export interface ProviderRoute {
  apiKeyEnv?: string;
  displayName?: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseURL?: string;
  models?: { id: string }[];
}

/** The adapter row whose `providers` map holds Tack-configured routes. */
export const MULTI_PROVIDER_NS = "llm-pi-ai";

interface Services {
  agentDefaultModel?: { currentSelection(): ModelSelection; saveSelection(next: ModelSelection): Promise<void> };
  llm?: {
    listProviders(): { id: string; name: string }[];
    listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]>;
  };
  settings?: {
    mutate(ns: string, ops: readonly ({ op: "set"; path: readonly string[]; value: unknown } | { op: "unset"; path: readonly string[] })[]): Promise<void>;
    describe(): { ns: string; value: unknown }[];
  };
}

export type ServiceGetter = { get(service: string): unknown };

function service<K extends keyof Services>(ctx: ServiceGetter, name: K): NonNullable<Services[K]> {
  const found = ctx.get(name) as Services[K] | undefined;
  if (found === undefined) throw new Error(`tack: the runtime service "${name}" is not available in this profile`);
  return found as NonNullable<Services[K]>;
}

export function currentSelection(ctx: ServiceGetter): ModelSelection {
  const { provider, model, reasoningEffort } = service(ctx, "agentDefaultModel").currentSelection();
  return { provider, model, ...(reasoningEffort !== undefined && { reasoningEffort }) };
}

export async function listProviderModels(ctx: ServiceGetter, only?: string): Promise<ProviderModels[]> {
  const llm = service(ctx, "llm");
  const providers = llm.listProviders().filter((provider) => only === undefined || provider.id === only);
  if (only !== undefined && providers.length === 0) throw new Error(`tack: provider "${only}" is not configured`);
  const result: ProviderModels[] = [];
  for (const provider of providers) {
    const models = await llm.listModels(provider.id).catch(() => []);
    result.push({ provider: provider.id, name: provider.name, models: models.map(({ id, name }) => ({ id, name })) });
  }
  return result;
}

/**
 * Save the default model. The provider must be routable in this profile; a
 * model the provider does not list is allowed (routes accept unlisted ids) but
 * reported through the returned flag.
 */
export async function saveSelection(ctx: ServiceGetter, next: ModelSelection): Promise<{ listed: boolean }> {
  const llm = service(ctx, "llm");
  if (!llm.listProviders().some((provider) => provider.id === next.provider)) {
    throw new Error(`tack: provider "${next.provider}" is not configured; add it with \`tack provider add ${next.provider}\``);
  }
  const models = await llm.listModels(next.provider).catch(() => []);
  await service(ctx, "agentDefaultModel").saveSelection(next);
  return { listed: models.some((model) => model.id === next.model) };
}

/** Routes configured through the multi-provider adapter in this profile. */
export function configuredRoutes(ctx: ServiceGetter): Record<string, ProviderRoute> {
  const section = service(ctx, "settings")
    .describe()
    .find((entry) => entry.ns === MULTI_PROVIDER_NS);
  const providers = (section?.value as { providers?: Record<string, ProviderRoute> } | undefined)?.providers;
  return { ...(providers ?? {}) };
}

export async function setRoute(ctx: ServiceGetter, id: string, route: ProviderRoute): Promise<void> {
  await service(ctx, "settings").mutate(MULTI_PROVIDER_NS, [{ op: "set", path: ["providers", id], value: route }]);
}

export async function removeRoute(ctx: ServiceGetter, id: string): Promise<boolean> {
  if (!(id in configuredRoutes(ctx))) return false;
  await service(ctx, "settings").mutate(MULTI_PROVIDER_NS, [{ op: "unset", path: ["providers", id] }]);
  return true;
}
