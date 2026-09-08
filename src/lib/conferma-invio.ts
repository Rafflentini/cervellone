/**
 * src/lib/conferma-invio.ts — «invia pure la mail», su tutti e due i canali.
 *
 * La regex viveva in due copie identiche (`telegram/route.ts` e `chat/route.ts`)
 * ma la PRE-NORMALIZZAZIONE della voce stava solo su Telegram: una fix su un
 * canale che non era stata portata sull'altro. Quando l'8 set 2026 la chat web
 * ha avuto la dettatura, il web e' rimasto quello che non capisce «in via pure
 * la mail» — e una mail data per inviata non lo era.
 *
 * Qui la regola sta scritta una volta sola.
 */

/**
 * Ripara gli artefatti tipici della trascrizione vocale, e solo quelli:
 * - «in via» → «invia» (sia Telegram sia il riconoscimento del browser)
 * - «pura» / «puro» → «pure» (genere sbagliato dallo speech-to-text)
 */
export function normalizzaPerConferma(testo: string): string {
  return testo
    .trim()
    .replace(/\bin\s+via\b/gi, 'invia')
    .replace(/\bpur[ao]\b/gi, 'pure')
}

/**
 * Vera SOLO per le frasi-conferma brevi. «invia una mail a Mario con il
 * preventivo» e' una composizione, non una conferma: confonderle manderebbe
 * la bozza sbagliata.
 */
const RE_CONFERMA =
  /^\s*(s[iì][,.\s]+)?(conferm[oai]\s+(l'?\s*)?invio|(invia|manda|spedisci)(la|lo|tela)?(\s+pure)?\s+(la\s+|quella\s+)?(mail|email|e-?mail|messaggio))(\s+pure)?\s*[.!…]*\s*$/i

export function eConfermaInvio(testo: string): boolean {
  return RE_CONFERMA.test(normalizzaPerConferma(testo))
}
