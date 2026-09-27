import { describe, expect, it } from "@rstest/core";
import { reconcileTemplateBundles } from "../../packages/tack/src/profiles.js";

const template = ["runtime-base", "runtime-app", "@tack/base", "@tack/run"];

describe("reconcileTemplateBundles", () => {
  it("leaves a correct profile alone", () => {
    expect(reconcileTemplateBundles([...template, "user-plugin"], template)).toBeUndefined();
  });

  it("migrates the legacy Tack bundle and keeps user plugins after the template", () => {
    expect(reconcileTemplateBundles(["runtime-base", "runtime-app", "@tack/bundle-default", "user-plugin"], template)).toEqual([
      ...template,
      "user-plugin",
    ]);
  });

  it("restores missing template bundles in template order", () => {
    expect(reconcileTemplateBundles(["user-plugin", "runtime-app"], template)).toEqual([...template, "user-plugin"]);
  });

  it("drops duplicates", () => {
    expect(reconcileTemplateBundles([...template, "a", "a"], template)).toEqual([...template, "a"]);
  });
});
