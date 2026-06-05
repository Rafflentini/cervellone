/**
 * Cost-control 5 giu 2026: i tool result vengono rimessi in contesto a OGNI
 * iterazione del loop (input non-cached). Un risultato da 100K char (~25K token)
 * × 10 iterazioni = 250K token. Cap esplicito con marker, così il modello sa
 * che il contenuto è parziale e può richiederlo a pezzi se serve.
 */
export const MAX_TOOL_RESULT_CHARS = 30_000

export function truncateToolResult<T>(result: T, max: number = MAX_TOOL_RESULT_CHARS): T | string {
  if (typeof result !== 'string') return result
  if (result.length <= max) return result
  return (
    result.slice(0, max) +
    `\n\n…[output troncato: ${result.length} caratteri totali, mostrati i primi ${max}. ` +
    `Se servono le parti successive, richiedile in modo mirato (es. range, filtro, pagina).]`
  )
}
