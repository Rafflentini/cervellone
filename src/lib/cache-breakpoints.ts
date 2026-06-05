/**
 * Cost-control 5 giu 2026: breakpoint di cache "mobile" sulla coda dei messages.
 * Il prefisso tools+system è già cachato (buildCachedSystem). Questo helper
 * cacha ANCHE la conversazione accumulata nel tool-loop: a ogni iterazione
 * sposta un singolo breakpoint ephemeral sull'ultimo blocco dell'ultimo
 * messaggio, così l'iterazione successiva paga il prefisso come cache_read
 * (~10% del prezzo input) invece che input pieno.
 *
 * Limite Anthropic: max 4 breakpoint totali → 1 sul system + 1 mobile qui = 2.
 * Sotto la soglia minima cacheabile (1024/2048 token) il breakpoint è ignorato
 * dall'API senza errori: il no-op è sicuro.
 */
import type Anthropic from '@anthropic-ai/sdk'

export function applyIncrementalCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  // 1) Strip dei breakpoint esistenti nei messages (il limite è 4 totali)
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as unknown as Array<Record<string, unknown>>) {
      if (block && typeof block === 'object' && 'cache_control' in block) {
        delete (block as { cache_control?: unknown }).cache_control
      }
    }
  }
  // 2) Breakpoint sull'ultimo blocco dell'ultimo messaggio
  const last = messages[messages.length - 1]
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return
  const lastBlock = last.content[last.content.length - 1] as unknown as Record<string, unknown>
  lastBlock.cache_control = { type: 'ephemeral' }
}
