/**
 * Cost-control 5 giu 2026: con il cache breakpoint incrementale nel tool-loop
 * (commit 61a1359) i tool result grossi vengono cachati dopo la prima iterazione,
 * quindi il costo di re-invio è quasi zero. Il cap serve solo da estremo anti-runaway
 * e NON deve strozzare i flussi documentali (lettura DVR/computi da Drive che servono
 * interi, cap interno dei tool di download già a 100K).
 * I tool che gestiscono payload di testo (es. get_email_body) applicano un cap interno
 * più stretto sui singoli campi per garantire JSON sempre valido.
 */
export const MAX_TOOL_RESULT_CHARS = 100_000

export function truncateToolResult<T>(result: T, max: number = MAX_TOOL_RESULT_CHARS): T | string {
  if (typeof result !== 'string') return result
  if (result.length <= max) return result
  return (
    result.slice(0, max) +
    `\n\n…[output troncato: ${result.length} caratteri totali, mostrati i primi ${max}. ` +
    `Se servono le parti successive, richiedile in modo mirato (es. range, filtro, pagina).]`
  )
}
