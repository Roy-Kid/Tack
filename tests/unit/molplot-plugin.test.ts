import { describe, expect, it } from "@rstest/core";
import { chartPage } from "../../packages/molplot/src/chart.js";
import { molplotTools } from "../../packages/molplot/src/index.js";

describe("molplot", () => {
  it("puts MolPlot's element around the spec and loads MolPlot's bundle", () => {
    const html = chartPage("Energy", { mark: "bar", data: { values: [{ cat: "a", val: 1 }] } });
    expect(html).toContain("<molplot-chart");
    expect(html).toContain('<script type="module" src="/vendor/elements.js">');
    expect(html).toContain('"mark":"bar"');
    expect(html).not.toContain("vega.embed");
  });

  it("asks for a read-only preview and leaves the element's layout to MolPlot", () => {
    const html = chartPage("Energy", { mark: "bar" });
    expect(html).toContain('<molplot-chart mode="readonly" label="Energy"');
    expect(chartPage('a "b" <c>', {})).toContain('label="a &quot;b&quot; &lt;c&gt;"');
    // A page rule on the element overrode MolPlot's layout and the chart grew.
    expect(html).not.toMatch(/molplot-chart\s*\{/);
    // No favicon request to a server that has none.
    expect(html).toContain('<link rel="icon" href="data:,">');
  });

  it("publishes the page MolPlot specified and refuses a series of the wrong length", async () => {
    const pages = new Map<string, string>();
    const [chart, workbench] = molplotTools(
      {
        runner: { spec: async (request) => ({ mark: request.kind, title: request.title }) },
        server: {
          url: "http://127.0.0.1:8771",
          publish: (name, html) => {
            pages.set(name, html);
            return `http://127.0.0.1:8771/${name}`;
          },
          close: async () => {},
        },
      },
      async (script, port) => `http://127.0.0.1:${port}/?script=${script}`,
    );
    const value = await chart!.execute({
      kind: "bar",
      title: "Chain energy",
      name: "chain-energy",
      categories: ["before", "after"],
      series: [{ id: "e", values: [28.91, 15.19] }],
      yLabel: "eV",
    });
    expect(value.meta.url).toBe("http://127.0.0.1:8771/chain-energy.html");
    expect(pages.get("chain-energy.html")).toContain("<molplot-chart");
    await expect(chart!.execute({ kind: "bar", title: "Bad", categories: ["a"], series: [{ id: "e", values: [1, 2] }] })).rejects.toThrow(/values/);
    const bench = await workbench!.execute({ script: "figures.py" });
    expect(bench.meta.url).toBe("http://127.0.0.1:8772/?script=figures.py");
  });
});
