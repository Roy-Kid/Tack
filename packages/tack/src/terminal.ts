/**
 * Tack's terminal adapter. Tack owns its process's terminal: every line the
 * runtime prints under its own label is relabelled as Tack's before it reaches
 * the user. Pure Tack code; no runtime imports.
 *
 * The runtime writes each labelled line in one write call, so a label is only
 * rewritten where a write begins a line. Unlabelled output (answers, streamed
 * reasoning text, JSON events) passes through byte-for-byte.
 */

/** Runtime line labels and their Tack replacements, longest first. */
export const LABELS: readonly (readonly [string, string])[] = [
  ["dsh web: ", "tack web: "],
  ["dsh: ", "tack: "],
];

export interface LineState {
  atLineStart: boolean;
}

/** Relabel every line start in `chunk`; `state` carries whether the previous chunk ended a line. */
export function relabelChunk(chunk: string, state: LineState, labels: readonly (readonly [string, string])[] = LABELS): string {
  let out = "";
  let index = 0;
  let atLineStart = state.atLineStart;
  while (index < chunk.length) {
    const newline = chunk.indexOf("\n", index);
    const end = newline === -1 ? chunk.length : newline + 1;
    let segment = chunk.slice(index, end);
    if (atLineStart) {
      for (const [from, to] of labels) {
        if (segment.startsWith(from)) {
          segment = to + segment.slice(from.length);
          break;
        }
      }
    }
    out += segment;
    atLineStart = newline !== -1;
    index = end;
  }
  state.atLineStart = chunk.length === 0 ? state.atLineStart : atLineStart;
  return out;
}

type WriteArgs = [chunk: unknown, encodingOrCallback?: unknown, callback?: unknown];

/** Route a stream's string writes through {@link relabelChunk}. Returns an uninstaller. */
export function relabelStream(stream: NodeJS.WriteStream): () => void {
  const original = stream.write.bind(stream) as (...args: WriteArgs) => boolean;
  const state: LineState = { atLineStart: true };
  stream.write = ((...args: WriteArgs) => {
    const [chunk, ...rest] = args;
    if (typeof chunk === "string") return original(relabelChunk(chunk, state), ...rest);
    if (chunk instanceof Uint8Array) {
      const text = Buffer.from(chunk).toString("utf8");
      const relabelled = relabelChunk(text, state);
      return original(relabelled === text ? chunk : relabelled, ...rest);
    }
    return original(chunk, ...rest);
  }) as NodeJS.WriteStream["write"];
  return () => {
    stream.write = original as NodeJS.WriteStream["write"];
  };
}

/**
 * Install Tack's terminal adapter for a command. stderr is always relabelled.
 * stdout is relabelled only when it carries no answer or machine-readable stream.
 */
export function installTerminalAdapter(options: { stdout: boolean }): void {
  relabelStream(process.stderr);
  if (options.stdout) relabelStream(process.stdout);
}
