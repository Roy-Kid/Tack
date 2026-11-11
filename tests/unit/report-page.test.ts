/**
 * The shareable Report is one HTML page: the conclusion first, the analysis,
 * the evidence, and a picture only when the cited file is an image.
 */
import { describe, expect, it } from "@rstest/core";
import { renderReportPage, reportDirectory, retractionNote } from "../../packages/research/src/report-page.js";

const page = {
  title: "Fragment analysis",
  summary: "Five fragments confirmed.",
  body: "The bridge is piperidinium.\n\nA second paragraph.",
  evidence: ["experiments/screen/scratch/analysis.md", "experiments/screen/scratch/plot.png", "molab:run/screen/r1"],
  delegation: "knowledges/delegation-chain.md",
  directory: reportDirectory(""),
  date: "2026-11-03",
};

describe("an HTML Report", () => {
  it("renders one page, the same text twice, with the image beside its path", () => {
    const html = renderReportPage(page);
    expect(html).toBe(renderReportPage(page));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<h1>Fragment analysis</h1>");
    expect(html).toContain('<p class="lead">Five fragments confirmed.</p>');
    expect(html).toContain("<p>The bridge is piperidinium.</p>");
    expect(html).toContain("<p>A second paragraph.</p>");
    expect(html).toContain('href="../experiments/screen/scratch/analysis.md"');
    expect(html).toContain("experiments/screen/scratch/analysis.md");
    expect(html).toContain('src="../experiments/screen/scratch/plot.png"');
    expect(html).not.toContain("analysis.md\" alt");
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain("molab:run/screen/r1");
    expect(html).toContain("knowledges/delegation-chain.md");
    expect(html).toContain("2026-11-03");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<link rel="icon" href="data:,">');
  });

  it("escapes text that would become markup", () => {
    const html = renderReportPage({ ...page, title: "<script>alert(1)</script>", body: `a "quoted" <b>tag</b>` });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('a "quoted" &lt;b&gt;tag&lt;/b&gt;');
  });

  it("numbers chapters and links a remote citation without embedding it", () => {
    const html = renderReportPage({
      ...page,
      body: "## Bridge\n\nThe bridge is piperidinium.\n\n## Next\n\nA second paragraph.",
      evidence: ["https://example.test/note"],
    });
    expect(html).toContain('<span class="num">1</span> Bridge');
    expect(html).toContain('href="#s2"');
    expect(html).toContain('href="https://example.test/note"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/<script/i);
  });

  it("embeds a chart page and keeps a workspace image in its chapter", () => {
    const html = renderReportPage({
      ...page,
      body: "",
      sections: [{
        heading: "Chain",
        prose: "One chain.",
        frames: [
          { src: "http://127.0.0.1:8771/energy.html", caption: "Energy" },
          { src: "experiments/screen/scratch/plot.png", caption: "Unit" },
        ],
      }],
      evidenceTitle: "References",
    });
    expect(html).toContain('<iframe src="http://127.0.0.1:8771/energy.html"');
    expect(html).toContain("max-width: 76rem");
    expect(html).toContain('src="../experiments/screen/scratch/plot.png"');
    expect(html).toContain(">References</h2>");
    expect(html).not.toMatch(/<script/i);
  });

  it("gives a chart a short frame and a molecule a tall one", () => {
    const html = renderReportPage({
      ...page,
      body: "",
      sections: [{
        heading: "Views",
        prose: "Both.",
        frames: [
          { src: "http://127.0.0.1:8771/energy.html", caption: "Energy", kind: "chart" },
          { src: "http://localhost:1/", caption: "Chain", kind: "molecule" },
        ],
      }],
    });
    expect(html).toContain('<iframe class="chart" src="http://127.0.0.1:8771/energy.html"');
    expect(html).toContain('<iframe class="molecule" src="http://localhost:1/"');
    // Frames follow the figure's shape and may go fullscreen (markup, not script).
    expect(html).toContain("iframe.chart { height: auto; aspect-ratio: 16 / 6;");
    expect(html).toContain("iframe.molecule { height: auto; aspect-ratio: 16 / 9;");
    expect(html).toContain("border-radius: 8px");
    expect(html).toContain('loading="lazy" allow="fullscreen"></iframe>');
    expect(html).not.toMatch(/<script/i);
  });

  it("points an image at the file from a nested host", () => {
    const html = renderReportPage({ ...page, directory: reportDirectory("experiments/screen"), evidence: ["experiments/screen/scratch/plot.png"] });
    expect(html).toContain('src="../scratch/plot.png"');
  });

  it("keeps a retracted page as HTML and a markdown note as markdown", () => {
    const html = retractionNote(renderReportPage(page), { date: "2026-11-04", reason: "written twice", replacement: "knowledges/next.md" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Retracted 2026-11-04");
    expect(html).toContain("written twice");
    expect(html).toContain("Replaced by knowledges/next.md.");
    expect(html).toMatch(/<aside class="retracted">[\s\S]*written twice[\s\S]*<\/aside>\n<\/article>/);
    expect(html).not.toMatch(/<script/i);
    expect(retractionNote("# Note\n\nText.", { date: "2026-11-04", reason: "wrong" })).toBe("# Note\n\nText.\n\n## Retracted 2026-11-04\n\nwrong\n");
  });
});
