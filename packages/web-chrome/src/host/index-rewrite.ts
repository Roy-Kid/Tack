/** Serve-time rewrites of the runtime's page shell. Pure string transforms. */
import { ASSET_ROUTE, type ChromeConfig } from "./config.js";
import { brandAssets } from "./assets.js";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** Replace the title and every icon and manifest link with Tack's chrome. */
export function rewriteIndex(html: string, chrome: ChromeConfig): string {
  const route = ASSET_ROUTE.slice(1);
  const assets = brandAssets(chrome);
  const links = [
    `<link rel="manifest" href="${route}/manifest.webmanifest" />`,
    `<link rel="icon" type="${assets.faviconDark.type}" href="${route}/favicon-dark" media="(prefers-color-scheme: dark)" />`,
    `<link rel="icon" type="${assets.favicon.type}" href="${route}/favicon" media="(prefers-color-scheme: light)" />`,
  ].join("\n    ");
  return html
    .replace(/[ \t]*<link\b[^>]*\brel="(?:icon|manifest|apple-touch-icon)"[^>]*>\n?/g, "")
    .replace(/<title>[\s\S]*?<\/title>/, `${links}\n    <title>${escapeHtml(chrome.product.name)}</title>`);
}

/**
 * A head script that relabels the boot splash as soon as the runtime's shell
 * builds it. React adopts that DOM as-is at mount, so the text persists.
 */
export function splashScript(wordmark: string, hint: string): string {
  const values = JSON.stringify({ wordmark, hint }).replace(/</g, "\\u003c");
  return `(()=>{const v=${values};const relabel=()=>{const card=document.querySelector("[data-dsh-boot]")?.firstElementChild;if(!card)return;const [mark,,note]=card.children;if(mark&&mark.textContent!==v.wordmark)mark.textContent=v.wordmark;if(note&&note.textContent!==v.hint)note.textContent=v.hint};const o=new MutationObserver(relabel);o.observe(document,{childList:true,subtree:true});addEventListener("load",()=>setTimeout(()=>o.disconnect(),30000))})();`;
}
