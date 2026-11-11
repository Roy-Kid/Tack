/**
 * The reader-facing Report is one HTML page. Molab still stores it as a
 * knowledge document; the body is the page, so opening or forwarding that
 * body needs nothing else.
 *
 * A chapter is a `##` heading in the analysis, or an explicit section.
 * A workspace path is a link to that file. An http(s) frame is an embedded
 * page (a MolPlot chart or a MolVis viewer). The page itself has no script.
 */
import { posix } from "node:path";

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const CHAPTER = /^##\s+(\S.*)$/;

export interface ReportFrame {
  /** An http(s) page, embedded, or a workspace path shown as an image. */
  src: string;
  caption: string;
  /** `chart` is a short plot. `molecule` is a structure view. */
  kind?: "chart" | "molecule";
}

export interface ReportTable {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface ReportSection {
  heading: string;
  prose: string;
  table?: ReportTable;
  frames?: readonly ReportFrame[];
}

export interface ReportPage {
  title: string;
  /** The conclusion, a few sentences, shown before the analysis. */
  summary: string;
  /** The analysis, in prose. A line `## Heading` starts a numbered chapter. */
  body: string;
  /** When set, these chapters replace `body`. */
  sections?: readonly ReportSection[];
  evidence: readonly string[];
  /** Heading of the citation list. Default `Evidence`. */
  evidenceTitle?: string;
  delegation: string;
  /** Directory of the Report file, so a link points at the workspace file. */
  directory: string;
  /** Calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Document language. Default `en`. */
  lang?: string;
}

/** Where molab writes the Report: `<host>/knowledges`. */
export function reportDirectory(hostPath: string): string {
  return hostPath === "" ? "knowledges" : `${hostPath}/knowledges`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** A workspace path as seen from the Report's directory, safe to put in an attribute. */
function relativeTo(directory: string, target: string): string {
  const rel = posix.relative(directory, target);
  return encodeURI(rel === "" ? posix.basename(target) : rel);
}

function paragraphs(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => `<p>${escapeText(part).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Chapters written as `##` lines. No such line means the analysis is one block. */
export function chaptersOf(body: string): ReportSection[] | undefined {
  const lines = body.split("\n");
  if (!lines.some((line) => CHAPTER.test(line.trim()))) return undefined;
  const sections: ReportSection[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    if (heading === "" && buf.join("").trim() === "") return;
    sections.push({ heading: heading === "" ? "Analysis" : heading, prose: buf.join("\n").trim() });
  };
  for (const line of lines) {
    const match = CHAPTER.exec(line.trim());
    if (match?.[1] !== undefined) {
      flush();
      heading = match[1].trim();
      buf = [];
    } else buf.push(line);
  }
  flush();
  return sections;
}

function isRemote(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function linkedPath(item: string, directory: string): string {
  if (item.startsWith("molab:") || item.includes(" ")) return `<code>${escapeText(item)}</code>`;
  const href = isRemote(item) ? item : relativeTo(directory, item);
  return `<a href="${escapeAttr(href)}"><code>${escapeText(item)}</code></a>`;
}

function evidenceItem(item: string, directory: string, embedImages: boolean): string {
  const label = linkedPath(item, directory);
  if (!embedImages || item.startsWith("molab:") || isRemote(item) || !IMAGE.test(item)) return `<li>${label}</li>`;
  const src = escapeAttr(relativeTo(directory, item));
  const alt = escapeAttr(posix.basename(item));
  return `<li>${label}<figure><img src="${src}" alt="${alt}"><figcaption>${escapeText(posix.basename(item))}</figcaption></figure></li>`;
}

function frameSrc(directory: string, src: string): string {
  return isRemote(src) ? src : relativeTo(directory, src);
}

function frameHtml(frame: ReportFrame, directory: string): string {
  const src = escapeAttr(frameSrc(directory, frame.src));
  const caption = escapeText(frame.caption);
  const frameClass = frame.kind === "chart" || frame.kind === "molecule" ? ` class="${frame.kind}"` : "";
  const body = isRemote(frame.src) || /\.html?$/i.test(frame.src)
    ? `<iframe${frameClass} src="${src}" title="${escapeAttr(frame.caption)}" loading="lazy" allow="fullscreen"></iframe>`
    : `<img src="${src}" alt="${escapeAttr(frame.caption)}">`;
  return `<figure>${body}<figcaption>${caption}</figcaption></figure>`;
}

function tableHtml(table: ReportTable): string {
  const head = table.columns.map((column) => `<th>${escapeText(column)}</th>`).join("");
  const rows = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeText(cell)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<figure class="sheet"><table><caption>${escapeText(table.caption)}</caption><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></figure>`;
}

function sectionHtml(section: ReportSection, index: number, directory: string): string {
  const frames = (section.frames ?? []).map((frame) => frameHtml(frame, directory)).join("\n");
  const table = section.table === undefined ? "" : `\n${tableHtml(section.table)}`;
  return `<section id="s${index}">
<h2><span class="num">${index}</span> ${escapeText(section.heading)}</h2>
${paragraphs(section.prose)}${table}
${frames}
</section>`;
}

const STYLE = `
  :root { color-scheme: light; }
  html { background: #fff; }
  body { margin: 0; color: #1a1a1a; font: 16.5px/1.65 "Songti SC", "STSong", "Noto Serif CJK SC", Palatino, Georgia, serif; }
  article { max-width: 76rem; margin: 0 auto; padding: 2.75rem 1.5rem 4rem; }
  header.mast { border-bottom: 2px solid #1a1a1a; padding-bottom: 0.9rem; margin-bottom: 1.25rem; }
  .kicker, nav, h2, figcaption, footer, caption, th, .num { font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Segoe UI", sans-serif; }
  .kicker { font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; margin: 0 0 0.45rem; color: #444; }
  h1 { font-size: 1.7rem; line-height: 1.25; font-weight: 650; margin: 0; }
  .meta { margin: 0.55rem 0 0; font-size: 0.9rem; }
  .lead { font-size: 1.08rem; line-height: 1.55; margin: 1.1rem 0 0; }
  nav.toc { margin: 1.25rem 0 0.25rem; }
  nav.toc ol { margin: 0.3rem 0 0; padding-left: 1.3rem; }
  nav.toc a { text-decoration: none; }
  h2 { font-size: 1.15rem; font-weight: 650; margin: 2.1rem 0 0.7rem; padding-bottom: 0.25rem; border-bottom: 1px solid #ddd; }
  .num { font-variant-numeric: tabular-nums; margin-right: 0.45rem; color: #444; }
  p, li { margin: 0.5rem 0; }
  a { color: #0b3d91; }
  a:hover { color: #06245c; }
  figure { margin: 1rem 0 1.25rem; }
  figcaption, caption { font-size: 0.85rem; color: #333; text-align: left; margin-top: 0.4rem; }
  img { max-width: 100%; height: auto; background: #fff; }
  iframe { display: block; width: 100%; height: 28rem; border: 1px solid #e0e0e0; border-radius: 8px; background: #fff; }
  iframe.chart { height: auto; aspect-ratio: 16 / 6; min-height: 18rem; }
  iframe.molecule { height: auto; aspect-ratio: 16 / 9; min-height: 22rem; max-height: 40rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  th, td { border-bottom: 1px solid #ddd; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
  th { font-weight: 600; background: #f6f6f6; }
  code { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.84em; }
  footer, .retracted { font: 13px/1.45 "PingFang SC", "Hiragino Sans GB", sans-serif; color: #444; }
  footer { margin-top: 2.5rem; border-top: 1px solid #ddd; padding-top: 0.8rem; }
  .retracted { margin-top: 2.5rem; padding-top: 0.8rem; border-top: 1px solid #c4b8a8; }
  .retracted h2 { color: #8a3b2c; margin-top: 0; border: 0; }
  @media print {
    iframe { height: 16rem; aspect-ratio: auto; }
    iframe.chart { height: 14rem; min-height: 0; }
    iframe.molecule { height: 22rem; min-height: 0; }
    a { color: #000; }
  }
`;

/** One self-contained page. The same input renders the same text, and the text has no script. */
export function renderReportPage(page: ReportPage): string {
  const sections = page.sections ?? chaptersOf(page.body);
  const analysis = sections === undefined
    ? paragraphs(page.body)
    : sections.map((section, index) => sectionHtml(section, index + 1, page.directory)).join("\n");
  const toc = sections === undefined
    ? ""
    : `<nav class="toc" aria-label="Contents"><ol>\n${sections.map((section, index) => `<li><a href="#s${index + 1}">${escapeText(section.heading)}</a></li>`).join("\n")}\n</ol></nav>`;
  const items = page.evidence.map((item) => evidenceItem(item, page.directory, page.sections === undefined)).join("\n");
  const evidenceTitle = page.evidenceTitle ?? "Evidence";
  const lang = page.lang ?? "en";
  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${escapeText(page.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<article>
<header class="mast">
<p class="kicker">Report</p>
<h1>${escapeText(page.title)}</h1>
<p class="meta">${linkedPath(page.delegation, page.directory)} · ${escapeText(page.date)}</p>
</header>
<p class="lead">${escapeText(page.summary.trim())}</p>
${toc}
${analysis}
<h2>${escapeText(evidenceTitle)}</h2>
<ol class="refs">
${items}
</ol>
<footer>
<p>${linkedPath(page.delegation, page.directory)}</p>
<p>${escapeText(page.date)}</p>
</footer>
</article>
</body>
</html>
`;
}

/** Mark a document retracted. An HTML Report stays one page; anything else keeps the markdown note. */
export function retractionNote(body: string, note: { date: string; reason: string; replacement?: string }): string {
  if (!/^\s*<!doctype html/i.test(body)) {
    const lines = [`## Retracted ${note.date}`, "", note.reason.trim(), ...(note.replacement !== undefined ? ["", `Replaced by ${note.replacement}.`] : []), ""];
    return `${body.trimEnd()}\n\n${lines.join("\n")}`;
  }
  const replaced = note.replacement === undefined ? "" : `<p>Replaced by ${escapeText(note.replacement)}.</p>`;
  const aside = `<aside class="retracted"><h2>Retracted ${escapeText(note.date)}</h2><p>${escapeText(note.reason.trim())}</p>${replaced}</aside>\n`;
  if (body.includes("</article>")) return body.replace("</article>", `${aside}</article>`);
  if (body.includes("</body>")) return body.replace("</body>", `${aside}</body>`);
  return `${body}\n${aside}`;
}
