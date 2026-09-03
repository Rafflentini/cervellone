/**
 * lib/template-fill-docx.ts — Riempie il .docx VERO dell'Ingegnere.
 *
 * È il "binario A" progettato l'11 giugno 2026 e mai costruito. La differenza
 * con `template-fill-html.ts` non è tecnica, è di risultato:
 *
 * - **B_html** ricostruisce il documento da un HTML nostro. L'impaginazione è
 *   una nostra imitazione: font, margini, intestazioni, loghi, tabulazioni —
 *   tutto rifatto a occhio, e ogni volta un po' diverso.
 * - **A_docx** apre il file .docx originale, sostituisce i soli segnaposto e
 *   restituisce lo stesso file. Fedeltà identica per costruzione: quello che
 *   non è un segnaposto non viene toccato.
 *
 * È la ragione per cui il piano di giugno esisteva, ed è il difetto che sta
 * sotto al disastro POS del 4 giugno ("il bot rigenera il documento invece di
 * usare il mio").
 *
 * Funzioni PURE: entra un Buffer, esce un Buffer. Nessuna rete, nessun Drive —
 * quelli stanno nel chiamante, così questa parte è verificabile davvero.
 */

import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'

/** Delimitatori dei segnaposto dentro il .docx: `{nome}`. */
const DELIMITERS = { start: '{', end: '}' }

export interface EsitoRiempimento {
  ok: boolean
  /** Il .docx riempito. Presente solo se ok. */
  buffer?: Buffer
  error?: string
  /** Segnaposto presenti nel modello per cui NON è stato passato un valore. */
  mancanti?: string[]
}

/**
 * Elenca i segnaposto `{campo}` presenti in un modello .docx.
 *
 * Serve a registrare un modello senza che nessuno debba trascrivere a mano
 * l'elenco dei campi: si carica il file e il sistema legge da sé cosa chiede.
 */
export function estraiSegnaposto(docx: Buffer): { ok: boolean; campi?: string[]; error?: string } {
  try {
    const zip = new PizZip(docx)
    const doc = new Docxtemplater(zip, { delimiters: DELIMITERS, paragraphLoop: true, linebreaks: true })
    // `getFullText()` SENZA argomento legge solo `word/document.xml`, mentre
    // `render()` riempie anche intestazioni e piè di pagina. Su una carta
    // intestata — cioè il caso normale di questo binario — il `{committente}`
    // sta in intestazione: leggendo il solo corpo il documento sembrerebbe
    // privo di segnaposto pur essendo perfettamente riempibile.
    // `targets` è l'elenco tipizzato delle parti che il motore compila
    // ("used to know which files are templated", docxtemplater.d.ts:213).
    const parti: string[] = doc.targets ?? []
    const testo = parti
      .map((p) => {
        try {
          return doc.getFullText(p)
        } catch {
          // Una parte non testuale non è un errore: semplicemente non contiene testo.
          return ''
        }
      })
      .join('\n')
    const trovati = [...testo.matchAll(/\{([^{}]+)\}/g)]
      .map((m) => m[1].trim())
      // `#nome` e `/nome` aprono e chiudono un blocco ripetuto: il campo è lo
      // stesso, e va elencato una volta sola.
      .map((n) => n.replace(/^[#/^]/, '').trim())
      .filter(Boolean)
    return { ok: true, campi: [...new Set(trovati)] }
  } catch (err) {
    return { ok: false, error: messaggioErrore(err) }
  }
}

/**
 * Sostituisce i segnaposto del modello con i valori dati.
 *
 * I campi senza valore vengono riportati in `mancanti` e resi stringa vuota nel
 * documento. Non si inventa nulla e non si lascia `{campo}` a vista: un
 * segnaposto stampato in un documento che va a un committente è peggio di un
 * buco, perché sembra un errore di chi lo manda.
 */
export function riempiDocx(docx: Buffer, valori: Record<string, unknown>): EsitoRiempimento {
  const attesi = estraiSegnaposto(docx)
  if (!attesi.ok) return { ok: false, error: attesi.error }

  const mancanti = (attesi.campi ?? []).filter((c) => {
    const v = valori[c]
    return v === undefined || v === null || String(v).trim() === ''
  })

  try {
    const zip = new PizZip(docx)
    const doc = new Docxtemplater(zip, {
      delimiters: DELIMITERS,
      paragraphLoop: true,
      linebreaks: true,
      // Un campo non passato diventa stringa vuota invece di far fallire tutto:
      // il documento parziale è utile (l'Ingegnere completa a mano), l'errore
      // secco no. I mancanti vengono comunque DICHIARATI nell'esito.
      nullGetter: () => '',
    })
    doc.render(normalizzaValori(valori))
    const buffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer
    return { ok: true, buffer, ...(mancanti.length ? { mancanti } : {}) }
  } catch (err) {
    return { ok: false, error: messaggioErrore(err), ...(mancanti.length ? { mancanti } : {}) }
  }
}

/**
 * I valori arrivano dal modello linguistico: numeri, date, booleani, oggetti.
 * docxtemplater scrive `[object Object]` senza protestare, e quella stringa
 * finisce in un documento che va a un committente.
 */
function normalizzaValori(valori: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(valori)) {
    if (v === null || v === undefined) { out[k] = ''; continue }
    // Gli array restano array: servono ai blocchi ripetuti {#righe}...{/righe}.
    if (Array.isArray(v)) {
      out[k] = v.map((riga) =>
        riga && typeof riga === 'object' && !Array.isArray(riga)
          ? normalizzaValori(riga as Record<string, unknown>)
          : String(riga),
      )
      continue
    }
    if (typeof v === 'object') {
      // L'oggetto va TENUTO oggetto: serve all'accesso annidato `{cliente.nome}`.
      // Ma se finisce in un segnaposto semplice `{cliente}`, docxtemplater lo
      // converte a stringa e scrive "[object Object]" — dentro una lettera che
      // va a un committente. Il `toString` gli da' una forma leggibile senza
      // togliere l'accesso ai sottocampi: si ottengono entrambe le cose.
      const annidato = normalizzaValori(v as Record<string, unknown>)
      Object.defineProperty(annidato, 'toString', {
        value: () => Object.values(annidato).filter((x) => typeof x === 'string' && x !== '').join(' '),
        enumerable: false,
      })
      out[k] = annidato
      continue
    }
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

export interface EsitoVerificaMaster {
  ok: boolean
  error?: string
  /** I segnaposto realmente presenti nel master (corpo, intestazioni, piè di pagina). */
  campi?: string[]
  /**
   * Campi dichiarati in registrazione che nel master non compaiono. È un
   * AVVISO, non un rifiuto: vedi la nota sotto.
   */
  dichiaratiAssenti?: string[]
}

/**
 * Controlla che un master .docx sia davvero riempibile, PRIMA di registrarlo.
 *
 * Senza questo, `insegna_modello` accettava qualunque `master_drive_id` senza
 * mai aprire il file e rispondeva *"Modello salvato, da ora puoi chiedermi di
 * riprodurlo"*. Un PDF al posto di un .docx, o un Word senza un solo `{campo}`,
 * producevano una registrazione che sembrava riuscita e che in compilazione
 * restituiva una copia intatta del master, con zero dati dentro. È la stessa
 * famiglia delle mail dichiarate spedite: il messaggio di successo arriva prima
 * del fatto.
 *
 * **Rifiuta solo ciò di cui è certa** — file illeggibile, zero segnaposto — e
 * per il resto avvisa. Un primo tentativo di questa guardia rifiutava anche i
 * campi dichiarati e non trovati: sbagliato in tre modi diversi, perché
 * `{cliente.nome}` non è il campo `cliente`, `{#voci}` è un blocco e non un
 * campo, e prima della correzione qui sopra le intestazioni non si leggevano
 * affatto. Una guardia che blocca il caso normale è peggio del buco che chiude.
 */
export function verificaMasterDocx(docx: Buffer, campiDichiarati?: string[]): EsitoVerificaMaster {
  const letto = estraiSegnaposto(docx)
  if (!letto.ok) {
    return { ok: false, error: `Il file indicato non è un .docx leggibile (${letto.error}). Il modello NON è stato registrato.` }
  }

  const campi = letto.campi ?? []
  if (campi.length === 0) {
    return {
      ok: false,
      campi: [],
      error:
        "Il file non contiene nemmeno un segnaposto: non c'è niente da riempire. " +
        'Apri il .docx e scrivi i punti variabili come {committente}, {oggetto}, {data} — ' +
        'poi registralo di nuovo. Il modello NON è stato registrato.',
    }
  }

  // Un campo dichiarato ma assente verrebbe chiesto all'utente e poi non
  // finirebbe da nessuna parte. Si DICE, non si blocca: la corrispondenza non è
  // mai esatta (`{cliente.nome}` soddisfa un campo `cliente`, un blocco
  // `{#voci}` dichiara le proprie colonne) e un falso rifiuto renderebbe un
  // documento valido irregistrabile per sempre.
  const soddisfatto = (nome: string) =>
    campi.some((c) => c === nome || c.startsWith(`${nome}.`) || nome.startsWith(`${c}.`))
  const assenti = (campiDichiarati ?? []).filter((c) => c.trim() !== '' && !soddisfatto(c))

  return { ok: true, campi, ...(assenti.length ? { dichiaratiAssenti: assenti } : {}) }
}

/**
 * docxtemplater impacchetta gli errori di template in `properties.errors`: il
 * `message` generico ("Multi error") non dice quale segnaposto è rotto, ed è
 * l'unica cosa che servirebbe sapere.
 */
function messaggioErrore(err: unknown): string {
  const e = err as { message?: string; properties?: { errors?: Array<{ properties?: { explanation?: string } }> } }
  const dettagli = e?.properties?.errors
    ?.map((x) => x?.properties?.explanation)
    .filter(Boolean)
    .join(' · ')
  if (dettagli) return `${e.message ?? 'Errore modello'}: ${dettagli}`
  return e?.message ?? String(err)
}
