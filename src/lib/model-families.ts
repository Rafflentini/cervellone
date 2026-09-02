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
  // `|| 'altro'` copre anche il segmento vuoto (id degeneri come "claude-"),
  // che altrimenti produrrebbe righe ": claude-" e un warning con un elemento
  // vuoto in testa.
  return parti.find(p => p !== '' && !/^\d/.test(p)) || 'altro'
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
  totaleGrezzo?: number,
): string {
  // Il conteggio grezzo e' quello PRIMA del filtro claude-/embed applicato dal
  // chiamante. Senza, il totale coprirebbe solo il raggruppamento e non il
  // filtro — cioe' proprio il punto in cui un id puo' sparire in silenzio,
  // la stessa superficie dell'incidente Fable.
  const scartati = totaleGrezzo !== undefined ? totaleGrezzo - models.length : 0

  if (models.length === 0) {
    const nota = scartati > 0 ? ` (${scartati} restituiti dall'API ma scartati dal filtro)` : ''
    return `Nessun modello Claude restituito dall'API Anthropic${nota}.\n`
  }

  const perFamiglia = raggruppaPerFamiglia(models)
  const inUso = new Set(familiesInUso)

  // Le famiglie che la config usa restano in cima, nell'ordine dichiarato; le
  // altre seguono in ordine alfabetico, cosi' l'elenco e' stabile.
  const ordinate = [
    ...familiesInUso,
    ...[...perFamiglia.keys()].filter(f => !inUso.has(f)).sort(),
  ]

  const intestazione = scartati > 0
    ? `${models.length} su ${totaleGrezzo} restituiti dall'API Anthropic`
    : `${models.length} dall'API Anthropic`
  let out = `🔍 MODELLI CLAUDE DISPONIBILI (${intestazione}):\n\n`
  for (const f of ordinate) {
    // Una famiglia IN USO che l'API non restituisce va stampata come "nessuno",
    // non omessa: altrimenti l'assenza torna a essere indistinguibile dal
    // silenzio, ed e' esattamente il difetto che questo modulo esiste per chiudere.
    const ids = perFamiglia.get(f)?.map(m => m.id).join(', ') ?? 'nessuno'
    out += `${f}: ${ids}\n`
  }
  if (scartati > 0) {
    out += `\n⚠️ ${scartati} modelli restituiti dall'API NON sono in questo elenco (scartati dal filtro). L'elenco non è tutto ciò che esiste.\n`
  }

  const nonUsate = ordinate.filter(f => !inUso.has(f))
  if (nonUsate.length > 0) {
    out += `\nFamiglie che ESISTONO ma che la configurazione non usa: ${nonUsate.join(', ')}.\n`
    out += `Non dire che non esistono: non le sto usando, è diverso.\n`
    // Senza questa riga il testo apre un condizionale ("se servono...") che il
    // modello puo' soddisfare da solo chiamando cervellone_modifica, che si
    // autodescrive come strumento per "auto-migliorarti".
    out += `NON cambiare la configurazione di tua iniziativa: cambiare modello lo decide l'Ingegnere, e costa di più.\n`
  }
  return out
}

/** Il modello piu' recente di una famiglia, o null se la famiglia non c'e'. */
export function migliorePerFamiglia(models: ModelInfo[], famiglia: string): string | null {
  const gruppo = raggruppaPerFamiglia(models).get(famiglia)
  return gruppo?.[0]?.id ?? null
}
