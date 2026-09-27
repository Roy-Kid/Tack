/**
 * Tailwind 4 theme → runtime design tokens.
 *
 * Integrators hand Tack the theme CSS their project already uses (Tailwind v4
 * `@theme` / `@theme inline` blocks, shadcn-style `:root` and `.dark` blocks).
 * Tack reads only the custom-property declarations, re-scopes them onto the
 * page, and maps the Tailwind names it knows onto the runtime's tokens with
 * `var()`, so the browser resolves every value (oklch, calc, var chains).
 *
 * This table is the only place runtime token names appear. Pure: no I/O.
 */

export type Scheme = "light" | "dark";

export interface ThemeDeclarations {
  light: Map<string, string>;
  dark: Map<string, string>;
}

/** Tailwind name(s) → runtime tokens. The first defined source name wins. */
export interface TokenMapping {
  from: readonly string[];
  to: readonly string[];
  /** Build each target's value from the source reference; default `var(<source>)`. */
  value?: (source: string, target: string) => string;
}

const mix = (percent: number) => (source: string) => `color-mix(in oklab, var(${source}) ${percent}%, transparent)`;

export const TOKEN_MAPPINGS: readonly TokenMapping[] = [
  { from: ["--color-background", "--background"], to: ["--dsw-alias-bg-base", "--dsw-alias-bg-document-preview"] },
  { from: ["--color-foreground", "--foreground"], to: ["--dsw-alias-label-primary", "--dsw-alias-label-primary-bluish", "--dsw-alias-label-document-preview"] },
  { from: ["--color-card", "--card"], to: ["--dsw-alias-bg-layer-1", "--dsw-alias-settings-card-fill"] },
  { from: ["--color-popover", "--popover"], to: ["--dsw-alias-bg-layer-2", "--dsw-alias-bg-layer-3", "--dsw-specific-menu", "--dsw-specific-selector"] },
  { from: ["--color-secondary", "--secondary"], to: ["--dsw-specific-bubble", "--dsw-alias-button-elevated-fill"] },
  {
    from: ["--color-muted", "--muted"],
    to: ["--dsw-alias-bg-overlay", "--dsw-alias-bg-skeleton", "--dsw-alias-markdown-inline-code", "--dsw-alias-markdown-code-block"],
  },
  {
    from: ["--color-muted-foreground", "--muted-foreground"],
    to: ["--dsw-alias-label-secondary", "--dsw-alias-label-tertiary", "--dsw-alias-label-caption", "--dsw-alias-menu-icon"],
  },
  {
    from: ["--color-accent", "--accent"],
    to: ["--dsw-alias-interactive-bg-hover", "--dsw-alias-button-ghost-hover", "--dsw-specific-sidebar-nav-item-hover"],
  },
  {
    from: ["--color-primary", "--primary"],
    to: ["--dsw-alias-brand-primary", "--dsw-alias-button-primary-fill", "--dsw-alias-button-info-fill", "--dsw-alias-button-info-hover"],
  },
  { from: ["--color-primary-foreground", "--primary-foreground"], to: ["--dsw-alias-label-primary-foreground", "--dsw-alias-brand-primary-invert"] },
  { from: ["--color-ring", "--ring"], to: ["--dsw-alias-state-business-primary", "--dsw-alias-link", "--dsw-focus-ring-color"] },
  { from: ["--color-destructive", "--destructive"], to: ["--dsw-alias-state-error-primary"] },
  { from: ["--color-success", "--success"], to: ["--dsw-alias-state-success-primary"] },
  { from: ["--color-warning", "--warning"], to: ["--dsw-alias-state-warn-primary"] },
  { from: ["--color-border", "--border"], to: ["--dsw-alias-border-l2"] },
  { from: ["--color-border", "--border"], to: ["--dsw-alias-border-l1"], value: mix(55) },
  { from: ["--color-input", "--input", "--color-border", "--border"], to: ["--dsw-alias-border-l3", "--dsw-alias-border-l4"] },
  { from: ["--color-sidebar", "--sidebar"], to: ["--dsw-specific-sidebar-fill"] },
  {
    from: ["--color-sidebar-accent", "--sidebar-accent"],
    to: ["--dsw-specific-sidebar-nav-item-active", "--dsw-specific-sidebar-nav-item-hover"],
  },
  { from: ["--font-sans"], to: ["--dsw-font-family"] },
  { from: ["--font-mono"], to: ["--ds-font-family-code"] },
  { from: ["--font-heading", "--font-display"], to: ["--dsw-font-family-brand"] },
  { from: ["--radius-xs"], to: ["--dsw-radius-xs"] },
  { from: ["--radius-sm"], to: ["--dsw-radius-sm"] },
  { from: ["--radius-md"], to: ["--dsw-radius-md"] },
  { from: ["--radius-lg"], to: ["--dsw-radius-lg"] },
  { from: ["--radius-xl"], to: ["--dsw-radius-xl"] },
  { from: ["--radius-2xl", "--radius-3xl"], to: ["--dsw-radius-panel"] },
  { from: ["--shadow-sm"], to: ["--dsw-shadow-lv1"] },
  { from: ["--shadow-md"], to: ["--dsw-shadow-lv2"] },
  { from: ["--shadow-lg"], to: ["--dsw-shadow-lv3"] },
];

/** When only shadcn's single `--radius` is set, the runtime's radius scale is derived from it. */
export const RADIUS_FROM_BASE: Readonly<Record<string, string>> = {
  "--dsw-radius-xs": "calc(var(--radius) * 0.4)",
  "--dsw-radius-sm": "calc(var(--radius) * 0.6)",
  "--dsw-radius-md": "var(--radius)",
  "--dsw-radius-lg": "calc(var(--radius) * 1.4)",
  "--dsw-radius-xl": "calc(var(--radius) * 1.8)",
  "--dsw-radius-panel": "calc(var(--radius) * 2.4)",
};

/** Runtime tokens resolved at the document root rather than on body. */
const ROOT_TOKENS = new Set(["--dsw-font-family", "--ds-font-family-code", "--dsw-font-family-brand"]);

/** Runtime token prefixes an integrator may set directly (escape hatch). */
const PASSTHROUGH = /^--(dsw|ds|dsh|shiki)-/;

// Selectors that carry a scheme. Higher specificity than the runtime's own stylesheets.
export const LIGHT_SELECTOR = "html:root, html body";
export const DARK_SELECTOR = "html body[data-ds-dark-theme]";

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

interface Block {
  prelude: string;
  body: string;
}

/** Top-level `prelude { body }` blocks and `prelude;` statements (statements dropped). */
function blocks(css: string): Block[] {
  const out: Block[] = [];
  let depth = 0;
  let start = 0;
  let bodyStart = -1;
  let quote: string | undefined;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]!;
    if (quote !== undefined) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        out.push({ prelude: css.slice(start, bodyStart - 1).trim(), body: css.slice(bodyStart, i) });
        start = i + 1;
      }
    } else if (ch === ";" && depth === 0) start = i + 1;
  }
  return out;
}

/** Custom-property declarations of one block body (nested blocks ignored). */
export function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let current = "";
  let quote: string | undefined;
  const flush = () => {
    const text = current.trim();
    current = "";
    const colon = text.indexOf(":");
    if (!text.startsWith("--") || colon === -1) return;
    const name = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim().replace(/\s*!important$/, "");
    if (value !== "") out.push([name, value]);
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quote !== undefined) {
      current += ch;
      if (ch === "\\") current += body[++i] ?? "";
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === ";" && depth === 0) flush();
    else if (depth === 0 && ch === "}") current = "";
    else current += ch;
  }
  flush();
  return out.filter(([name]) => !name.includes("{"));
}

const THEME_AT_RULE = /^@theme(\s+(inline|static|default|reference))*\s*$/;
const LIGHT_SELECTORS = /^(:root|html|:host|:root\s*,\s*:host|:host\s*,\s*:root|\*)$/;
const DARK_SELECTORS = /^(\.dark|:root\.dark|html\.dark|\.dark\s*:root|:root\[data-theme=["']?dark["']?\]|html\[data-theme=["']?dark["']?\]|\[data-theme=["']?dark["']?\]|\.dark\s*,\s*\[data-theme=["']?dark["']?\])$/;
const DARK_MEDIA = /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/;

function schemeOf(prelude: string): Scheme | undefined {
  const normalized = prelude.replace(/\s+/g, " ").trim();
  if (THEME_AT_RULE.test(normalized) || LIGHT_SELECTORS.test(normalized)) return "light";
  if (DARK_SELECTORS.test(normalized)) return "dark";
  return undefined;
}

/** Read every scheme-scoped custom property from Tailwind 4 / shadcn theme CSS. */
export function parseTheme(css: string): ThemeDeclarations {
  const result: ThemeDeclarations = { light: new Map(), dark: new Map() };
  const visit = (text: string, inherited?: Scheme) => {
    for (const block of blocks(text)) {
      const prelude = block.prelude.replace(/\s+/g, " ").trim();
      if (/^@layer\b/.test(prelude) || /^@media\b/.test(prelude) || /^@supports\b/.test(prelude)) {
        visit(block.body, DARK_MEDIA.test(prelude) ? "dark" : inherited);
        continue;
      }
      let scheme = schemeOf(prelude);
      if (scheme === "light" && inherited === "dark") scheme = "dark";
      if (scheme === undefined) continue;
      for (const [name, value] of declarations(block.body)) result[scheme].set(name, value);
    }
  };
  visit(stripComments(css));
  return result;
}

/** Runtime token → value, for every mapping whose source the theme defines. */
export function mapTokens(theme: ThemeDeclarations): Map<string, string> {
  const defined = (name: string) => theme.light.has(name) || theme.dark.has(name);
  const mapped = new Map<string, string>();
  for (const mapping of TOKEN_MAPPINGS) {
    const source = mapping.from.find(defined);
    if (source === undefined) continue;
    for (const target of mapping.to) mapped.set(target, mapping.value ? mapping.value(source, target) : `var(${source})`);
  }
  if (defined("--radius")) {
    for (const [target, value] of Object.entries(RADIUS_FROM_BASE)) if (!mapped.has(target)) mapped.set(target, value);
  }
  return mapped;
}

const CANVAS_TOKEN = "--dsw-alias-bg-base";

function rule(selector: string, entries: Iterable<[string, string]>): string {
  const lines = [...entries].map(([name, value]) => `  ${name}: ${value};`);
  return lines.length === 0 ? "" : `${selector} {\n${lines.join("\n")}\n}\n`;
}

export interface CompiledTheme {
  css: string;
  /** Tailwind names the theme defines that Tack maps onto runtime tokens. */
  mapped: string[];
  /** Runtime tokens the theme sets directly (escape hatch). */
  passthrough: string[];
}

/** Compile an integrator's Tailwind 4 theme (and optional custom CSS) into one page stylesheet. */
export function compileTheme(themeCss: string | undefined, customCss?: string, source = "theme"): CompiledTheme {
  const theme = themeCss === undefined ? { light: new Map(), dark: new Map() } : parseTheme(themeCss);
  const mapped = mapTokens(theme);
  const passthrough = [...new Set([...theme.light.keys(), ...theme.dark.keys()].filter((name) => PASSTHROUGH.test(name)))];
  const root = [...mapped].filter(([name]) => ROOT_TOKENS.has(name));
  const body = [...mapped].filter(([name]) => !ROOT_TOKENS.has(name));
  // The runtime paints a fixed canvas color before its styles load; follow the theme instead.
  if (mapped.has(CANVAS_TOKEN)) body.push(["--dsh-boot-bg", `var(${CANVAS_TOKEN})`], ["background-color", `var(${CANVAS_TOKEN})`]);
  const parts = [
    `/* Generated by Tack from ${source}. Integrator theme first, then Tack's token mapping. */\n`,
    rule(LIGHT_SELECTOR, theme.light),
    rule(DARK_SELECTOR, theme.dark),
    rule("html:root", root),
    // Also under the dark selector: the runtime's own dark palette rule outranks a plain `html body`.
    rule(`html body, ${DARK_SELECTOR}`, [...root, ...body]),
    customCss === undefined || customCss.trim() === "" ? "" : `/* Integrator custom CSS */\n${customCss.trim()}\n`,
  ];
  const usedSources = TOKEN_MAPPINGS.flatMap((mapping) => mapping.from).filter((name) => theme.light.has(name) || theme.dark.has(name));
  if (theme.light.has("--radius") || theme.dark.has("--radius")) usedSources.push("--radius");
  return { css: parts.filter(Boolean).join("\n"), mapped: [...new Set(usedSources)].sort(), passthrough: passthrough.sort() };
}
