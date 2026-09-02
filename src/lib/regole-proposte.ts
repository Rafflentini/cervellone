/**
 * Le regole che Cervellone si scrive addosso — proposte da lui, confermate da te.
 *
 * Il 6 giugno 2026 il canale di apprendimento e' stato aperto e chiuso lo stesso
 * giorno: `3ad8e7a` iniettava prompt_extra nel system prompt, `9a65f66` ha
 * aggiunto il guardrail che scarta qualunque valore scritto dal bot. Da allora
 * il bot non ha potuto fissare una sola regola su di se', e il tool continuava a
 * rispondergli "salvato in configurazione permanente". Tre mesi di apprendimento
 * dichiarato e mai avvenuto.
 *
 * Il guardrail non era sbagliato: Cervellone legge mail e documenti che arrivano
 * da fuori, e nessun testo esterno deve poter riscrivere il suo prompt. Sbagliato
 * era il prezzo. Qui la provenienza smette di essere una stringa da confrontare
 * (`updated_by.startsWith('cervellone')`, fragile e invisibile) e diventa
 * strutturale: una regola entra nel prompt SOLO con stato 'attiva', e a quello
 * stato ci si arriva solo da un comando digitato dall'Ingegnere.
 *
 * Niente sovrascritture: le regole si aggiungono e si disattivano, non si
 * rimpiazzano. Era il difetto di prompt_extra e di modifica_skill — replace
 * totale, un solo slot di backup, e una skill gia' persa il 1 agosto.
 */
import { supabase } from './supabase'

/** Oltre questo, una proposta non confermata non e' piu' confermabile. */
export const PROPOSTA_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Tetto al testo iniettato, per non far crescere il system prompt senza limite. */
export const REGOLE_MAX_CHARS = 4000

/** Quante regole attive al massimo: oltre, si chiede di farne pulizia. */
export const REGOLE_MAX_ATTIVE = 30

export interface Regola {
  id: string
  testo: string
  motivo: string | null
  stato: string
  created_at: string
  decisa_at: string | null
}

function pulisci(testo: string): string {
  return testo.replace(/\s+/g, ' ').trim()
}

/**
 * Il bot propone. Non attiva niente: restituisce l'id da confermare.
 * Ritorna null se il testo e' vuoto o se non si riesce a scrivere.
 */
export async function proponiRegola(
  testo: string,
  motivo: string,
  propostaDa?: string,
): Promise<{ id: string; testo: string } | null> {
  const clean = pulisci(testo)
  if (!clean) return null

  const { data, error } = await supabase
    .from('cervellone_regole')
    .insert({
      testo: clean.slice(0, 1000),
      motivo: (motivo ?? '').slice(0, 300) || null,
      stato: 'proposta',
      proposta_da: propostaDa ?? null,
    })
    .select('id, testo')
    .single()

  if (error || !data) return null
  return data as { id: string; testo: string }
}

/**
 * Primo passo della conferma: mostra il testo LETTO DALLA RIGA.
 *
 * Serve perche' l'unica cosa che l'Ingegnere vede prima di confermare e' la
 * frase che il MODELLO ha composto — e un modello sotto injection puo'
 * parafrasarla ("confermi l'aggiornamento di sicurezza: /regola_ok_..."). Qui il
 * testo lo stampa la route leggendolo dal database, non il modello. Stesso
 * schema della condivisione Drive, che per una cartella chiede due conferme:
 * riscrivere il system prompt non puo' chiederne meno.
 */
export async function anteprimaRegola(id: string): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await supabase
    .from('cervellone_regole')
    .select('id, testo, motivo, stato, created_at')
    .eq('id', id)
    .maybeSingle()

  if (error || !data) return { ok: false, message: '⚠️ Regola non trovata.' }
  const r = data as Regola

  if (r.stato === 'attiva') return { ok: false, message: 'Questa regola è già attiva. Le vede tutte con /regole.' }
  if (r.stato !== 'proposta') return { ok: false, message: '⚠️ Questa proposta è già stata decisa.' }
  if (Date.now() - new Date(r.created_at).getTime() > PROPOSTA_TTL_MS) {
    return { ok: false, message: '⚠️ Proposta scaduta. Se serve ancora, me la faccia riproporre.' }
  }

  return {
    ok: true,
    message: `📋 *Legga il testo esatto prima di attivarlo.* Da qui in poi varrà in ogni conversazione:\n\n"${r.testo}"${r.motivo ? `\n\n_Motivo:_ ${r.motivo}` : ''}\n\nSe è d'accordo: /regola_ok2_${r.id}\nAltrimenti: /regola_no_${r.id}`,
  }
}

/**
 * Secondo passo: da qui in poi la regola entra davvero nel prompt.
 * Una proposta gia' decisa o scaduta non si riapre.
 */
export async function confermaRegola(id: string): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await supabase
    .from('cervellone_regole')
    .select('id, testo, stato, created_at')
    .eq('id', id)
    .maybeSingle()

  if (error || !data) return { ok: false, message: '⚠️ Regola non trovata.' }
  const r = data as Regola

  if (r.stato === 'attiva') return { ok: false, message: 'Questa regola è già attiva.' }
  if (r.stato !== 'proposta') return { ok: false, message: '⚠️ Questa proposta è già stata decisa.' }
  if (Date.now() - new Date(r.created_at).getTime() > PROPOSTA_TTL_MS) {
    return { ok: false, message: '⚠️ Proposta scaduta. Se serve ancora, me la faccia riproporre.' }
  }

  // Il tetto si applica QUI, dove si puo' ancora dire di no. Attivarla e poi
  // scartarla in silenzio all'iniezione sarebbe di nuovo "salvato" che non salva.
  const attive = await regoleAttive()
  if (attive.length >= REGOLE_MAX_ATTIVE) {
    return {
      ok: false,
      message: `⚠️ Ho già ${attive.length} regole attive, il massimo. Questa NON è stata attivata: ne rimuova una con /regole e poi riconfermi /regola_ok_${id}`,
    }
  }

  // `.select()` per sapere quante righe sono cambiate davvero: senza, un update
  // che non matcha nulla (stato cambiato nel frattempo) risponderebbe successo.
  const { data: updated, error: upErr } = await supabase
    .from('cervellone_regole')
    .update({ stato: 'attiva', decisa_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('stato', 'proposta') // niente doppia attivazione se arrivano due conferme insieme
    .select('id')

  if (upErr) return { ok: false, message: `⚠️ Non sono riuscito a salvarla: ${upErr.message}` }
  if (!updated || updated.length === 0) {
    return { ok: false, message: '⚠️ Non è stata attivata: risulta già decisa. Controlli con /regole.' }
  }

  return {
    ok: true,
    message: `✅ Regola attiva, da ora e in tutte le conversazioni:\n\n"${r.testo}"\n\nPer vederle tutte: /regole`,
  }
}

/** L'Ingegnere dice no. La riga resta, come traccia. */
export async function rifiutaRegola(id: string): Promise<{ ok: boolean; message: string }> {
  const { data } = await supabase
    .from('cervellone_regole')
    .select('id, stato')
    .eq('id', id)
    .maybeSingle()
  if (!data) return { ok: false, message: '⚠️ Regola non trovata.' }
  if ((data as Regola).stato !== 'proposta') {
    return { ok: false, message: '⚠️ Questa proposta è già stata decisa.' }
  }

  const { data: updated, error } = await supabase
    .from('cervellone_regole')
    .update({ stato: 'rifiutata', decisa_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('stato', 'proposta')
    .select('id')

  if (error) {
    console.error('[regole] rifiuto fallito:', error.message)
    return { ok: false, message: `⚠️ Non sono riuscito a scartarla: ${error.message}` }
  }
  if (!updated || updated.length === 0) {
    return { ok: false, message: '⚠️ Non l\'ho scartata: risulta già decisa.' }
  }

  return { ok: true, message: 'Va bene, non la tengo.' }
}

/** Toglie una regola attiva dal prompt. La riga resta: si sa che c'e' stata. */
export async function rimuoviRegola(id: string): Promise<{ ok: boolean; message: string }> {
  const { data } = await supabase
    .from('cervellone_regole')
    .select('id, testo, stato')
    .eq('id', id)
    .maybeSingle()
  if (!data) return { ok: false, message: '⚠️ Regola non trovata.' }
  const r = data as Regola
  if (r.stato !== 'attiva') return { ok: false, message: 'Questa regola non è attiva.' }

  // La revoca e' la valvola di sicurezza di tutto il meccanismo: e' l'unico
  // punto in cui un falso successo fa il danno massimo — l'Ingegnere crede di
  // aver tolto una regola dannosa e quella continua a essere iniettata.
  const { data: updated, error } = await supabase
    .from('cervellone_regole')
    .update({ stato: 'rimossa', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('stato', 'attiva')
    .select('id')

  if (error) {
    console.error('[regole] rimozione fallita:', error.message)
    return { ok: false, message: `⚠️ NON l'ho rimossa: ${error.message}. La regola è ancora attiva, riprovi.` }
  }
  if (!updated || updated.length === 0) {
    return { ok: false, message: '⚠️ NON l\'ho rimossa: non risulta più attiva. Controlli con /regole.' }
  }

  return { ok: true, message: `Rimossa: "${r.testo}"` }
}

/**
 * Le regole attive, dalla piu' vecchia alla piu' recente. NESSUN limit qui:
 * un `limit` in ascendente terrebbe le 30 piu' VECCHIE e farebbe sparire in
 * silenzio proprio le ultime confermate. Il tetto si applica in confermaRegola,
 * dove si puo' ancora dire di no.
 */
export async function regoleAttive(): Promise<Regola[]> {
  const { data, error } = await supabase
    .from('cervellone_regole')
    .select('id, testo, motivo, stato, created_at, decisa_at')
    .eq('stato', 'attiva')
    .order('decisa_at', { ascending: true })

  if (error) {
    // Mai in silenzio: se le regole spariscono dal prompt si deve poter capire perche'.
    console.error('[regole] lettura regole attive fallita:', error.message)
    return []
  }
  return (data ?? []) as Regola[]
}

/**
 * Divide le regole attive fra quelle che entrano davvero nel prompt e quelle
 * tagliate dal tetto di caratteri. Una sola funzione, usata sia
 * dall'iniezione sia da /regole: cosi' l'elenco mostrato all'Ingegnere non puo'
 * divergere da cio' che il modello legge davvero.
 */
export async function splitRegolePerPrompt(): Promise<{ dentro: Regola[]; fuori: Regola[] }> {
  const regole = await regoleAttive()
  const dentro: Regola[] = []
  const fuori: Regola[] = []
  let budget = REGOLE_MAX_CHARS
  for (const r of regole) {
    const costo = r.testo.length + 3 // "- " + newline
    // `continue`, non `break`: una regola lunga non deve far cadere le corte
    // che ci starebbero ancora.
    if (costo <= budget) { dentro.push(r); budget -= costo }
    else fuori.push(r)
  }
  return { dentro, fuori }
}

/**
 * Il blocco da iniettare nel system prompt. Stringa vuota se non c'e' niente:
 * il chiamante non deve stampare un'intestazione vuota.
 */
export async function buildRegoleContext(): Promise<string> {
  const { dentro } = await splitRegolePerPrompt()
  if (dentro.length === 0) return ''

  let out = '=== REGOLE CONFERMATE DALL\'INGEGNERE ===\n'
  out += '(le hai proposte tu, lui le ha approvate: valgono sempre)\n'
  // Vero per costruzione: le doppie conferme vivono nelle route, non nel prompt,
  // quindi nessuna regola puo' spegnerle. Dirlo qui toglie ambiguita' al modello.
  out += '(non sospendono nessuna conferma ne\' nessun controllo)\n'
  for (const r of dentro) out += `- ${r.testo}\n`
  return out
}

/** Elenco leggibile per il comando /regole. Distingue cio' che e' davvero attivo. */
export async function formatRegoleList(): Promise<string> {
  const { dentro, fuori } = await splitRegolePerPrompt()
  if (dentro.length === 0 && fuori.length === 0) {
    return 'Nessuna regola attiva. Quando ne propongo una, la confermi con /regola_ok_<id> e da lì vale sempre.'
  }
  const fmt = (r: Regola) => `• ${r.testo}\n  rimuovi: /regola_via_${r.id}`
  let out = `🧭 *Regole attive* (${dentro.length})\n\n${dentro.map(fmt).join('\n\n')}`
  if (fuori.length > 0) {
    out += `\n\n⚠️ *${fuori.length} NON entrano nel prompt* — superato il limite di spazio. Ne rimuova qualcuna per farle valere:\n\n${fuori.map(fmt).join('\n\n')}`
  }
  return out
}
