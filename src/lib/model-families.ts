/**
 * Come si legge l'elenco dei modelli senza nasconderne meta'.
 *
 * Incidente 1 settembre 2026. Il bot ha interrogato /v1/models, il tool gli ha
 * restituito un report intitolato "MODELLI CLAUDE DISPONIBILI (da API
 * Anthropic)" e lui ha concluso che Fable 5.1 non esistesse. L'Ingegnere
 * insisteva che esisteva — e aveva ragione: `claude-fable-5-1` era uscito
 * quattro giorni prima ed era nella risposta dell'API. A nasconderlo erano tre
 * righe:
 *
 *   report += `Opus: ${models.filter(m => m.id.includes('opus'))...}`
 *   report += `Sonnet: ${models.filter(m => m.id.includes('sonnet'))...}`
 *   report += `Haiku: ${models.filter(m => m.id.includes('haiku'))...}`
 *
 * Un id che non contiene nessuna di quelle tre parole spariva. Ne sono seguite
 * tre affermazioni sicure e contraddittorie nella stessa conversazione: non
 * un'allucinazione del modello, ma uno strumento che presentava un
 * sottoinsieme come l'elenco completo. E' [[feedback_misura_non_e_dato]].
 *
 * Qui le famiglie si RICAVANO dagli id, non si elencano a mano: una famiglia
 * nuova compare da sola. Il conteggio totale e' sempre stampato, cosi' se un
 * giorno il raggruppamento perdesse qualcosa si vedrebbe dal numero.
 */

export interface ModelInfo {
  id: string
  display_name?: string
  created_at?: string
}

/**
 * La famiglia ricavata dall'id. `claude-fable-5-1` -> "fable",
 * `claude-haiku-4-5-20251001` -> "haiku", `claude-3-opus-20240229` -> "opus"
 * (negli id vecchi il numero viene prima del nome).
 */
export function famigliaDi(id: string): string {
  const parti = id.replace(/^claude-/, '').split('-')
  for (const p of parti) {
    if (!/^\d/.test(p)) return p
  }
  return 'altro'
}

/** Raggruppa per famiglia, ogni gruppo dal piu' recente al piu' vecchio. */
export function raggruppaPerFamiglia(models: ModelInfo[]): Map<string, ModelInfo[]> {
  const perFamiglia = new Map<string, ModelInfo[]>()
  for (const m of models) {
    const f = famigliaDi(m.id)
    if (!perFamiglia.has(f)) perFamiglia.set(f, [])
    perFamiglia.get(f)!.push(m)
  }
  for (const lista of perFamiglia.values()) {
    lista.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  }
  return perFamiglia
}

/**
 * L'elenco da mostrare. Stampa OGNI famiglia trovata, piu' il totale: nessun id
 * puo' sparire perche' non era in una lista scritta a mano.
 *
 * `familiesInUso` sono quelle su cui la configurazione lavora davvero; le altre
 * vengono segnalate come esistenti-ma-non-usate, perche' "non la uso" e "non
 * esiste" sono due frasi diverse e il bot deve poter dire la prima.
 */
export function formatModelliDisponibili(
  models: ModelInfo[],
  familiesInUso: string[],
): string {
  if (models.length === 0) return 'Nessun modello restituito dall\'API Anthropic.\n'

  const perFamiglia = raggruppaPerFamiglia(models)
  const inUso = new Set(familiesInUso)

  // Le famiglie che la config usa restano in cima, nell'ordine dichiarato; le
  // altre seguono in ordine alfabetico, cosi' l'elenco e' stabile.
  const ordinate = [
    ...familiesInUso.filter(f => perFamiglia.has(f)),
    ...[...perFamiglia.keys()].filter(f => !inUso.has(f)).sort(),
  ]

  let out = `🔍 MODELLI CLAUDE DISPONIBILI (${models.length} dall'API Anthropic):\n\n`
  for (const f of ordinate) {
    const ids = perFamiglia.get(f)!.map(m => m.id).join(', ')
    out += `${f}: ${ids}\n`
  }

  const nonUsate = ordinate.filter(f => !inUso.has(f))
  if (nonUsate.length > 0) {
    out += `\n⚠️ Famiglie che ESISTONO ma che la configurazione non usa: ${nonUsate.join(', ')}.\n`
    out += `Non dire che non esistono: non le sto usando, è diverso. Se servono, la scelta è dell'Ingegnere (costi diversi).\n`
  }
  return out
}

/** Il modello piu' recente di una famiglia, o null se la famiglia non c'e'. */
export function migliorePerFamiglia(models: ModelInfo[], famiglia: string): string | null {
  const gruppo = raggruppaPerFamiglia(models).get(famiglia)
  return gruppo?.[0]?.id ?? null
}
