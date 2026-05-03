/**
 * Token estimation heuristic: chars / 3.5, ceiling.
 * Intentionally rough — good enough for flagging large parts and computing
 * usage percentages. Not a substitute for a real tokenizer.
 */

export function estimateTokens(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0
  return Math.ceil(text.length / 3.5)
}
