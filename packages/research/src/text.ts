/** Text helpers the research modules share. */

/** `text` cut to `limit` characters, with an ellipsis when something was cut. */
export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
