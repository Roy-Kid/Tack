import { describe, expect, it } from "@rstest/core";
import { molvisTools } from "../../packages/molvis/src/index.js";
import { pageUrlFrom, viewArgs } from "../../packages/molvis/src/session.js";

describe("molvis", () => {
  it("asks MolVis for a light read-only preview page", () => {
    expect(viewArgs({ command: "stage", target: "chain.pdb", name: "pbix", style: "ball-and-stick" })).toEqual([
      "stage", "--preview", "--theme", "light", "--name", "pbix", "--style", "ball-and-stick", "chain.pdb",
    ]);
    expect(viewArgs({ command: "sketch", target: "*c1ccc(CCCBr)cc1" })).toEqual(["sketch", "--preview", "--theme", "light", "*c1ccc(CCCBr)cc1"]);
    // A trajectory is the same command; MolVis reads it.
    expect(viewArgs({ command: "stage", target: "run.lammpstrj" })).toEqual(["stage", "--preview", "--theme", "light", "run.lammpstrj"]);
  });

  it("reads the page url MolVis prints", () => {
    expect(pageUrlFrom("molvis: the page is at http://127.0.0.1:4311/\n")).toBe("http://127.0.0.1:4311/");
    expect(pageUrlFrom("still starting")).toBeUndefined();
  });

  it("returns that url and does not invent a second viewer", async () => {
    const tool = molvisTools({
      open: async (request) => ({ url: `http://127.0.0.1:9/${request.command}`, close() {} }),
    }).find((item) => item.name === "molvis_stage");
    const value = await tool!.execute({ file: "chain.pdb", name: "pbix" });
    expect(value.meta).toEqual({ url: "http://127.0.0.1:9/stage", command: "stage", target: "chain.pdb" });
    expect(value.text).toContain("http://127.0.0.1:9/stage");
    await expect(tool!.execute({})).rejects.toThrow(/structure file/);
  });
});
