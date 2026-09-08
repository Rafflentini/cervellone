/**
 * L'appartamento indicato in una nuova prenotazione deve essere UNO DI QUELLI
 * del Config.
 *
 * Il campo era libero, ed era il rischio che teneva fermo il go-live del 7
 * settembre 2026: un nome diverso da quelli configurati creava un appartamento
 * FANTASMA, che si sdoppiava nell'elenco del gestionale e produceva un file
 * Questura in piu'. La tendina lo rende impossibile dalla pagina; questo lo
 * rende impossibile anche a chi arriva dall'API, o con la tendina non caricata.
 *
 * Ma senza pedanteria: chi scrive a mano sbaglia gli accenti e le maiuscole,
 * non l'appartamento. "unita 1" e' "Unità 1", e rifiutarlo farebbe perdere una
 * prenotazione vera per un apostrofo.
 */

/** Toglie accenti, doppi spazi e maiuscole: quello che resta e' il nome. */
function chiave(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export type EsitoUnita =
  | { ok: true; unita: string }
  | { ok: false; errore: string }

export function normalizzaUnita(scritta: string, dalConfig: string[]): EsitoUnita {
  const pulita = String(scritta ?? '').replace(/\s+/g, ' ').trim()
  if (!pulita) return { ok: false, errore: "Indica l'unita." }

  // Config senza appartamenti: non si puo' bloccare tutto, o il gestionale
  // diventa inutilizzabile proprio il giorno in cui lo si configura.
  const valide = dalConfig.filter((u) => String(u ?? '').trim())
  if (valide.length === 0) return { ok: true, unita: pulita }

  const trovata = valide.find((u) => chiave(u) === chiave(pulita))
  if (trovata) return { ok: true, unita: trovata }

  return {
    ok: false,
    errore: `"${pulita}" non e' fra gli appartamenti configurati. Quelli veri sono: ${valide.join(', ')}.`,
  }
}
