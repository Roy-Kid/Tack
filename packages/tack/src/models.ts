/** `tack model`, `tack provider`, `tack auth` handlers. Tack-shaped: no runtime imports. */
import type { ModelSelection, ProviderRoute, Runtime } from "./runtime/dsh.js";

export type ModelInvocation =
  | { mode: "model"; action: "show"; profile?: string }
  | { mode: "model"; action: "list"; profile?: string; provider?: string }
  | { mode: "model"; action: "use"; profile?: string; selection: string }
  | { mode: "provider"; action: "list"; profile?: string }
  | { mode: "provider"; action: "add"; profile?: string; id: string; route: ProviderRoute }
  | { mode: "provider"; action: "remove"; profile?: string; id: string }
  | { mode: "auth"; action: "set"; ref: string }
  | { mode: "auth"; action: "status"; refs: string[] };

export interface Io {
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
}

/** Split `provider/model`; the model part may itself contain `/`. */
export function parseSelection(value: string): ModelSelection {
  const slash = value.indexOf("/");
  const provider = slash === -1 ? "" : value.slice(0, slash).trim();
  const model = slash === -1 ? "" : value.slice(slash + 1).trim();
  if (provider === "" || model === "") throw new Error(`tack: expected <provider>/<model>, got "${value}"`);
  return { provider, model };
}

export function formatSelection(selection: ModelSelection): string {
  return `${selection.provider}/${selection.model}${selection.reasoningEffort ? ` (reasoning: ${selection.reasoningEffort})` : ""}`;
}

/** The profiles a write targets: the named one, or every Tack profile (templates and existing). */
export function targetProfiles(runtime: Runtime, templates: readonly string[], profile?: string): string[] {
  if (profile !== undefined) return [profile];
  const names = new Set<string>(templates);
  for (const info of runtime.listProfiles()) names.add(info.name);
  return [...names];
}

const stdio: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
};

export async function runModelAction(
  runtime: Runtime,
  invocation: ModelInvocation,
  templates: readonly string[],
  io: Io = stdio,
): Promise<number> {
  const primary = invocation.mode !== "auth" && invocation.profile !== undefined ? invocation.profile : templates[0]!;
  switch (`${invocation.mode}:${invocation.action}`) {
    case "model:show": {
      for (const name of targetProfiles(runtime, templates, "profile" in invocation ? invocation.profile : undefined)) {
        io.out(`${name}: ${formatSelection(await runtime.currentModel(name))}\n`);
      }
      return 0;
    }
    case "model:list": {
      const provider = invocation.mode === "model" && invocation.action === "list" ? invocation.provider : undefined;
      for (const group of await runtime.listModels(primary, provider)) {
        io.out(`${group.provider} (${group.name})\n`);
        for (const model of group.models) io.out(`  ${group.provider}/${model.id}${model.name && model.name !== model.id ? `  ${model.name}` : ""}\n`);
        if (group.models.length === 0) io.out("  (no listed models)\n");
      }
      return 0;
    }
    case "model:use": {
      if (invocation.mode !== "model" || invocation.action !== "use") return 2;
      const selection = parseSelection(invocation.selection);
      for (const name of targetProfiles(runtime, templates, invocation.profile)) {
        const { listed } = await runtime.useModel(name, selection);
        io.out(`${name}: ${formatSelection(selection)}\n`);
        if (!listed) io.err(`tack: warning: ${selection.provider} does not list "${selection.model}"; requests will still be sent with that id\n`);
      }
      return 0;
    }
    case "provider:list": {
      for (const name of targetProfiles(runtime, templates, "profile" in invocation ? invocation.profile : undefined)) {
        const { routable, configured } = await runtime.listRoutes(name);
        io.out(`${name}: ${routable.map((route) => route.id).join(", ") || "(none)"}\n`);
        for (const [id, route] of Object.entries(configured)) {
          const details = [route.api, route.baseURL, route.apiKeyEnv && `key ${route.apiKeyEnv}`].filter(Boolean).join(", ");
          io.out(`  ${id}${details ? `  (${details})` : ""}\n`);
        }
      }
      return 0;
    }
    case "provider:add": {
      if (invocation.mode !== "provider" || invocation.action !== "add") return 2;
      for (const name of targetProfiles(runtime, templates, invocation.profile)) {
        await runtime.addRoute(name, invocation.id, invocation.route);
        io.out(`${name}: added ${invocation.id}\n`);
      }
      return 0;
    }
    case "provider:remove": {
      if (invocation.mode !== "provider" || invocation.action !== "remove") return 2;
      const targets = targetProfiles(runtime, templates, invocation.profile);
      for (const name of targets) {
        const current = await runtime.currentModel(name);
        if (current.provider === invocation.id) {
          io.err(`tack: "${invocation.id}" is the default model's provider in profile "${name}"; switch first with \`tack model use <provider>/<model>\`\n`);
          return 1;
        }
      }
      let removed = false;
      for (const name of targets) {
        if (await runtime.removeRoute(name, invocation.id)) {
          removed = true;
          io.out(`${name}: removed ${invocation.id}\n`);
        }
      }
      if (!removed) {
        io.err(`tack: provider "${invocation.id}" is not a configured route\n`);
        return 1;
      }
      return 0;
    }
    case "auth:set": {
      if (invocation.mode !== "auth" || invocation.action !== "set") return 2;
      const value = (await io.readStdin()).replace(/\r?\n$/, "");
      if (value === "") {
        io.err(`tack: no value on stdin; pipe the key, e.g. \`printf %s "$KEY" | tack auth set ${invocation.ref}\`\n`);
        return 1;
      }
      await runtime.setCredential(invocation.ref, value);
      io.out(`stored ${invocation.ref}\n`);
      return 0;
    }
    case "auth:status": {
      if (invocation.mode !== "auth" || invocation.action !== "status") return 2;
      let refs = invocation.refs;
      if (refs.length === 0) {
        const { configured } = await runtime.listRoutes(templates[0]!);
        refs = [...new Set(["DEEPSEEK_API_KEY", ...Object.values(configured).flatMap((route) => (route.apiKeyEnv ? [route.apiKeyEnv] : []))])];
      }
      for (const status of await runtime.credentialStatus(refs)) {
        io.out(`${status.ref}: ${status.configured ? `set${status.source ? ` (${status.source})` : ""}` : "not set"}\n`);
      }
      return 0;
    }
    default:
      return 2;
  }
}
