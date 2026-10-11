/**
 * The text of a thrown value, for showing to a person or an agent.
 *
 * `throw` accepts anything, so a caught value is only usually an Error. One
 * spelling for the fallback, rather than the same ternary in every catch.
 */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
