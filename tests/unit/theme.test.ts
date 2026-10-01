import { describe, expect, it } from "@rstest/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileTheme, declarations, mapTokens, parseTheme } from "../../packages/web-chrome/src/host/theme.js";
import { REPO_ROOT } from "../helpers.js";

const exampleTheme = readFileSync(join(REPO_ROOT, "examples", "web-chrome", "theme.css"), "utf8");

describe("parseTheme", () => {
  it("reads light, dark, and @theme custom properties and ignores everything else", () => {
    const theme = parseTheme(exampleTheme);
    expect(theme.light.get("--background")).toBe("oklch(0.985 0.004 95)");
    expect(theme.dark.get("--background")).toBe("oklch(0.17 0.015 265)");
    expect(theme.light.get("--color-background")).toBe("var(--background)");
    expect(theme.light.get("--font-sans")).toBe('"Inter", ui-sans-serif, system-ui, sans-serif');
    expect(theme.light.has("@apply")).toBe(false);
    expect([...theme.light.keys()].every((name) => name.startsWith("--"))).toBe(true);
  });

  it("understands the other dark spellings and nesting in @layer / @media", () => {
    const theme = parseTheme(`
      @layer base { :root { --a: 1px; } [data-theme="dark"] { --a: 2px; } }
      @media (prefers-color-scheme: dark) { :root { --b: red; } }
      html.dark { --c: blue; }
      .card { --not-a-theme: 1; color: red; }
    `);
    expect(theme.light.get("--a")).toBe("1px");
    expect(theme.dark.get("--a")).toBe("2px");
    expect(theme.dark.get("--b")).toBe("red");
    expect(theme.dark.get("--c")).toBe("blue");
    expect(theme.light.has("--not-a-theme")).toBe(false);
  });

  it("keeps values with parentheses, commas, and strings intact", () => {
    expect(declarations(` --x: color-mix(in oklab, var(--a) 50%, transparent); --y: "a;b"; color: red; --z: 1px !important `)).toEqual([
      ["--x", "color-mix(in oklab, var(--a) 50%, transparent)"],
      ["--y", '"a;b"'],
      ["--z", "1px"],
    ]);
  });
});

describe("mapTokens", () => {
  it("maps only Tailwind names the theme defines, preferring --color-* over bare names", () => {
    const mapped = mapTokens(parseTheme(":root { --color-background: #fff; --primary: #0a0; }"));
    expect(mapped.get("--dsw-alias-bg-base")).toBe("var(--color-background)");
    expect(mapped.get("--dsw-alias-brand-primary")).toBe("var(--primary)");
    expect(mapped.has("--dsw-alias-label-primary")).toBe(false);
  });

  it("derives the radius scale from shadcn's single --radius, but explicit radii win", () => {
    const derived = mapTokens(parseTheme(":root { --radius: 0.5rem; --radius-lg: 12px; }"));
    expect(derived.get("--dsw-radius-md")).toBe("var(--radius)");
    expect(derived.get("--dsw-radius-lg")).toBe("var(--radius-lg)");
  });
});

describe("compileTheme", () => {
  const compiled = compileTheme(exampleTheme, ".x { color: red; }", "theme.css");

  it("re-scopes the integrator's declarations for light and dark", () => {
    expect(compiled.css).toContain("html:root, html body {\n  --radius: 0.5rem;");
    expect(compiled.css).toContain("html body[data-ds-dark-theme] {\n  --background: oklch(0.17 0.015 265);");
  });

  it("maps runtime tokens with var() in both schemes and fonts at the root", () => {
    expect(compiled.css).toMatch(/html body, html body\[data-ds-dark-theme\] \{[^}]*--dsw-alias-bg-base: var\(--color-background\);/);
    expect(compiled.css).toMatch(/html:root \{[^}]*--dsw-font-family: var\(--font-sans\);/);
    expect(compiled.mapped).toContain("--color-primary");
  });

  it("appends custom CSS and passes runtime tokens through", () => {
    expect(compiled.css.trimEnd().endsWith(".x { color: red; }")).toBe(true);
    const direct = compileTheme(":root { --dsw-alias-link: hotpink; }");
    expect(direct.passthrough).toEqual(["--dsw-alias-link"]);
    expect(direct.css).toContain("--dsw-alias-link: hotpink;");
  });

  it("produces an empty-but-valid sheet when there is no theme", () => {
    expect(compileTheme(undefined).mapped).toEqual([]);
  });
});
