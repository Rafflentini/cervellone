/**
 * src/lib/conferma-invio.ts — «invia», su tutti e due i canali.
 *
 * La regex viveva in due copie identiche (`telegram/route.ts` e `chat/route.ts`)
 * ma la PRE-NORMALIZZAZIONE della voce stava solo su Telegram: una fix su un
 * canale che non era stata portata sull'altro. Quando l'8 set 2026 la chat web
 * ha avuto la dettatura, il web e' rimasto quello che non capisce «in via pure
 * la mail» — e una mail data per inviata non lo era.
 *
 * Qui la regola sta scritta una volta sola.
 *
 * 🚨 IL 12 SET 2026, MISURATO IN PRODUZIONE. Il bot ha preparato una bozza con
 * due contratti e ha scritto: «Mi dica "invia" e parto.» L'Ingegnere ha scritto
 * «Invia». Poi «Invia». Poi «India.» (la dettatura che sbaglia). La regola
 * pretendeva la parola «mail» DOPO il verbo, quindi non riconosceva nessuna
 * delle tre: ogni «Invia» e' stato letto come una richiesta NUOVA e il modello
 * ha preparato un'altra bozza. In `cervellone_email_pending_send` sono finite
 * CINQUE bozze identiche in attesa, e nessuna inviata.
 *
 * Il bot chiedeva di dire «invia» e il sistema non accettava «invia».
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
 * La frase che il bot SUGGERISCE all'utente per confermare.
 *
 * Sta qui, accanto alla regola che la deve accettare, e non nel messaggio che
 * la mostra: e' il legame che impedisce a suggerimento e regola di divergere.
 * Il 12 set 2026 il messaggio suggeriva «invia pure mail» — che funzionava —
 * ma il modello l'ha parafrasata in «invia», che NON funzionava. Un test qui
 * accanto prova che la frase suggerita e' accettata.
 */
export const FRASE_CONFERMA_SUGGERITA = 'invia pure mail'

/**
 * I verbi d'invio che possono stare DA SOLI, col pronome attaccato facoltativo:
 * «invia», «inviala», «manda», «mandala», «spedisci», «spediscila».
 */
const VERBO_INVIO = String.raw`(?:invia|manda|spedisci)(?:la|lo|tela)?`

/** Le parole di conferma esplicita: «confermo», «conferma», «confermato». */
const CONFERMA_SECCA = String.raw`conferm(?:ato|ata|o|a)`

/** La cosa da inviare, quando viene nominata: «la mail», «quella email». */
const OGGETTO = String.raw`(?:la\s+|quella\s+|questa\s+)?(?:mail|email|e-?mail|messaggio)`

/**
 * Vera SOLO per le frasi-conferma brevi.
 *
 * ⛔ IL CONFINE, ed e' deliberato: un VERBO D'INVIO esplicito oppure una PAROLA
 * DI CONFERMA esplicita. Niente di piu' vago. L'assenso generico — «ok»,
 * «vai», «procedi», «si'», «va bene», «perfetto» — NON conferma, e non e' una
 * dimenticanza: sono parole che si dicono in mille contesti, e con una bozza
 * ancora valida (la finestra e' 30 minuti) manderebbero a un destinatario
 * ESTERNO una mail che l'Ingegnere non intendeva spedire.
 *
 * ⛔ E le COMPOSIZIONI restano fuori: «invia una mail a Mario col preventivo»,
 * «manda la mail a luciana con gli allegati» sono richieste di SCRIVERE, non di
 * spedire. Confonderle manda la bozza sbagliata. L'ancora `$` in fondo e'
 * quello che le tiene fuori: appena c'e' altro testo dopo, non e' una conferma.
 *
 * ⚠️ Allargare questa regola e' il tipo di modifica che e' GIA' andata storta:
 * il 10 set 2026, in quest'area, un elenco di parole ammesse costruito male ha
 * fatto si' che «ok annulla» CREASSE il documento invece di annullarlo.
 */
const RE_CONFERMA = new RegExp(
  String.raw`^\s*(?:s[iì][,.\s]+)?(?:` +
    // «confermo invio», «conferma l'invio»
    String.raw`conferm[oai]\s+(?:l'?\s*)?invio` +
    '|' +
    // «invia pure la mail», «manda quella mail», «spedisci la email»
    String.raw`${VERBO_INVIO}(?:\s+pure)?\s+${OGGETTO}` +
    '|' +
    // «invia», «Invia.», «invia pure», «inviala», «mandala pure», «spediscila»
    String.raw`${VERBO_INVIO}(?:\s+pure)?` +
    '|' +
    // «confermo», «conferma», «confermato», «confermo pure»
    String.raw`${CONFERMA_SECCA}(?:\s+pure)?` +
    String.raw`)(?:\s+pure)?\s*[.!…]*\s*$`,
  'i',
)

export function eConfermaInvio(testo: string): boolean {
  return RE_CONFERMA.test(normalizzaPerConferma(testo))
}

/**
 * Quante parole ha il messaggio. Serve al riconoscimento del «messaggio breve
 * che non e' una conferma»: vedi `PAROLE_MESSAGGIO_BREVE`.
 */
export function contaParole(testo: string): number {
  const pulito = testo.trim()
  if (!pulito) return 0
  return pulito.split(/\s+/).length
}

/**
 * Oltre questa lunghezza un messaggio non e' piu' un tentativo di conferma ma
 * una richiesta nuova, e va lasciato al modello.
 */
export const PAROLE_MESSAGGIO_BREVE = 4

/**
 * Vera per un messaggio abbastanza breve da essere, plausibilmente, un tentativo
 * di rispondere alla domanda «le mando questa mail?».
 *
 * 🚨 Serve al difetto che all'Ingegnere e' pesato piu' di tutti, parole sue:
 * «non mi dice ne' che non lo ha fatto ne' che problema ha, questa cosa non
 * dovrebbe succedere». Quando c'e' una bozza in attesa e arriva un messaggio
 * breve che NON viene riconosciuto come conferma, il bot non deve ricominciare
 * in silenzio preparando un'altra bozza: deve dirlo.
 *
 * I comandi (`/...`) sono esclusi: hanno i loro rami, e intercettarli qui
 * romperebbe `/conferma_<codice>` e compagnia.
 */
export function eMessaggioBreveNonConferma(testo: string): boolean {
  const pulito = testo.trim()
  if (!pulito) return false
  if (pulito.startsWith('/')) return false
  if (contaParole(pulito) > PAROLE_MESSAGGIO_BREVE) return false
  return !eConfermaInvio(pulito)
}
