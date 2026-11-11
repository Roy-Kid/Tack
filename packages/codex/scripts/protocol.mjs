#!/usr/bin/env node
/**
 * Regenerate `src/protocol/` from the installed Codex's own app-server types.
 *
 * `codex app-server generate-ts` emits the whole protocol (hundreds of files);
 * only the transitive closure of the types the provider uses is kept, with
 * import specifiers made ESM-explicit. Run after bumping `@openai/codex`:
 *   node packages/codex/scripts/protocol.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Entry types the provider imports; everything they reference is kept. */
const ROOTS = [
  "InitializeParams",
  "InitializeResponse",
  "ServerRequest",
  "v2/ThreadStartParams",
  "v2/ThreadStartResponse",
  "v2/TurnStartParams",
  "v2/TurnStartResponse",
  "v2/TurnInterruptParams",
  "v2/TurnCompletedNotification",
  "v2/TurnStartedNotification",
  "v2/ItemCompletedNotification",
  "v2/ErrorNotification",
  "v2/ThreadTokenUsageUpdatedNotification",
  "v2/HooksListParams",
  "v2/HooksListResponse",
  // Answers to the server requests an unattended run receives.
  "ApplyPatchApprovalResponse",
  "ExecCommandApprovalResponse",
  "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalResponse",
  "v2/PermissionsRequestApprovalResponse",
  "v2/ToolRequestUserInputResponse",
  "v2/McpServerElicitationRequestResponse",
  "v2/DynamicToolCallResponse",
];

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(packageDir, "src", "protocol");
const codexPackage = createRequire(join(packageDir, "package.json")).resolve("@openai/codex/package.json");
const manifest = JSON.parse(readFileSync(codexPackage, "utf8"));
const codexBin = resolve(dirname(codexPackage), manifest.bin.codex);

const generated = mkdtempSync(join(tmpdir(), "codex-protocol-"));
try {
  execFileSync(process.execPath, [codexBin, "app-server", "generate-ts", "--out", generated], { stdio: "inherit" });
  const keep = new Set();
  const visit = (name) => {
    if (keep.has(name)) return;
    const file = join(generated, `${name}.ts`);
    if (!existsSync(file)) throw new Error(`codex protocol has no type ${name}`);
    keep.add(name);
    for (const match of readFileSync(file, "utf8").matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
      visit(relative(generated, resolve(dirname(file), match[1])));
    }
  };
  ROOTS.forEach(visit);
  rmSync(out, { recursive: true, force: true });
  for (const name of [...keep].sort()) {
    const target = join(out, `${name}.ts`);
    mkdirSync(dirname(target), { recursive: true });
    const text = readFileSync(join(generated, `${name}.ts`), "utf8").replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.js"');
    writeFileSync(target, text);
  }
  writeFileSync(
    join(out, "VERSION"),
    `${manifest.version}\n`,
  );
  console.log(`codex ${manifest.version}: kept ${keep.size} protocol types in ${relative(process.cwd(), out)}`);
} finally {
  rmSync(generated, { recursive: true, force: true });
}

