/**
 * Separatore tra la parte STATICA del system prompt (BASE_PROMPT, immutabile ->
 * cachata a 1h) e la parte VARIABILE (data/ora al minuto, skill per-messaggio,
 * prompt_extra -> NON cachata). I prompt builder (prompts.ts) lo inseriscono;
 * buildCachedSystem (claude.ts) ci splitta per cachare solo il prefisso statico.
 *
 * Audit 10 giu: prima data/ora/skill stavano DENTRO il blocco cachato -> la cache
 * si bustava ~ogni minuto. Separandoli, il prefisso grosso resta cache-hit.
 *
 * Token improbabile: non comparira' mai nel testo naturale del prompt.
 */
export const SYSTEM_CACHE_SPLIT = ' __CACHE_SPLIT__ '

/**
 * Divide un system prompt nelle due parti attorno a SYSTEM_CACHE_SPLIT.
 * Se il marker non c'e' (retrocompat), tutto e' statico e la variabile e' vuota.
 */
export function splitSystemPrompt(systemPrompt: string): { staticPart: string; variablePart: string } {
  const idx = systemPrompt.indexOf(SYSTEM_CACHE_SPLIT)
  if (idx < 0) return { staticPart: systemPrompt, variablePart: '' }
  return {
    staticPart: systemPrompt.slice(0, idx),
    variablePart: systemPrompt.slice(idx + SYSTEM_CACHE_SPLIT.length),
  }
}
