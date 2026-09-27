/**
 * Title ownership. The runtime's layout writes its own product name into
 * `document.title` (bare, or after the session name). Tack keeps any session
 * prefix and puts the configured product name in place of the runtime's.
 */
export const RUNTIME_PRODUCT = "DeepSeek Harness";
export const RUNTIME_SEPARATOR = " — ";

export function productTitle(current: string, name: string, separator: string): string {
  if (current === RUNTIME_PRODUCT || current.trim() === "") return name;
  if (current.endsWith(RUNTIME_SEPARATOR + RUNTIME_PRODUCT)) {
    return current.slice(0, -(RUNTIME_SEPARATOR + RUNTIME_PRODUCT).length) + separator + name;
  }
  return current;
}

export function ownTitle(name: string, separator: string): () => void {
  const apply = () => {
    const next = productTitle(document.title, name, separator);
    if (next !== document.title) document.title = next;
  };
  const observer = new MutationObserver(apply);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  apply();
  return () => observer.disconnect();
}
