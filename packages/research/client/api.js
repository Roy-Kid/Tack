/** The workbench's calls to Research's owner API. Every read is scoped to one conversation. */
const ENDPOINT = "api/tack/research";

async function read(params, signal) {
  const response = await fetch(`${ENDPOINT}?${new URLSearchParams(params)}`, { credentials: "same-origin", cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? `Research service returned ${response.status}`), { status: response.status });
  return result;
}

export const readBinding = (session, signal) => read({ session, binding: "1" }, signal).then(result => result.binding);
export const readSnapshot = (binding, signal) => read({ session: binding.sessionId, delegation: binding.delegation }, signal);
export const readMap = (binding, signal) => read({ session: binding.sessionId, delegation: binding.delegation, map: "1" }, signal);
export const readNode = (binding, node, signal) => read({ session: binding.sessionId, delegation: binding.delegation, node }, signal).then(result => result.body);
/** The address of one map document as a page of its own, for a new tab. */
export const nodePageUrl = (binding, node) => `${ENDPOINT}?${new URLSearchParams({ session: binding.sessionId, delegation: binding.delegation, node, page: "1" })}`;
export const readPlanBody = (binding, document, signal) => read({ session: binding.sessionId, delegation: binding.delegation, document }, signal).then(result => result.body);

/**
 * Act on the reviewed snapshot through the same research tools as the conversation:
 * `approve` (the pending gate), `answer`, `pause` or `resume`. The server refuses a record that changed since.
 */
export async function act(snapshot, action, answers = "") {
  const { item } = snapshot;
  const response = await fetch(ENDPOINT, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, delegation: item.path, digest: item.digest, answers, ...(action === "approve" && { gate: { gate: item.gate.gate, target: item.gate.target } }) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Research service returned ${response.status}`);
  return result;
}

/** Poll `load` while the tab is visible; returns the cleanup. `onResult(value)` / `onError(error)` run only while mounted. */
export function poll(load, every, onResult, onError) {
  const controller = new AbortController();
  let pending = false;
  const tick = async () => {
    if (pending) return;
    pending = true;
    try {
      const value = await load(controller.signal);
      if (!controller.signal.aborted) onResult(value);
    } catch (cause) {
      if (!controller.signal.aborted) onError(cause);
    } finally { pending = false; }
  };
  void tick();
  const timer = setInterval(() => { if (document.visibilityState === "visible") void tick(); }, every);
  return () => { controller.abort(); clearInterval(timer); };
}
