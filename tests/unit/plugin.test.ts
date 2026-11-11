import { describe, expect, it } from "@rstest/core";
import { compatStatus, formatPluginList } from "../../packages/tack/src/plugin.js";

describe("compatStatus", () => {
  it("classifies declared ranges against the Tack version", () => {
    expect(compatStatus("0.2.0", undefined)).toBe("undeclared");
    expect(compatStatus("0.2.0", "^0.2.0")).toBe("compatible");
    expect(compatStatus("0.2.0", "^0.1.0")).toBe("incompatible");
    expect(compatStatus("0.2.0", "not a range")).toBe("invalid");
  });

  it("admits prerelease Tack versions inside the range", () => {
    expect(compatStatus("0.2.1-rc.1", "^0.2.0")).toBe("compatible");
  });
});

describe("formatPluginList", () => {
  it("shows state and compatibility per plugin", () => {
    const text = formatPluginList(
      [
        { name: "a", version: "1.0.0", bundle: true, enabled: true, tackCompat: "^0.2.0" },
        { name: "b", version: "2.0.0", bundle: true, enabled: false },
        { name: "c", version: "3.0.0", bundle: false, enabled: false },
      ],
      "0.2.0",
    );
    expect(text).toContain("a@1.0.0  enabled  tack ^0.2.0 (compatible)");
    expect(text).toContain("b@2.0.0  disabled");
    expect(text).toContain("c@3.0.0  not a bundle");
  });

  it("says when nothing is installed", () => {
    expect(formatPluginList([], "0.2.0")).toContain("no plugins");
  });
});
