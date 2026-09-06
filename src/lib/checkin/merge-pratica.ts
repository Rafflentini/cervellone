/**
 * src/lib/checkin/merge-pratica.ts
 *
 * Fonde quello che arriva dal form con quello che c'e' gia' sul foglio,
 * decidendo campo per campo CHI ha il diritto di cambiarlo.
 *
 * E' la difesa vera, e sta qui e non nell'interfaccia. Un campo mostrato in
 * sola lettura nel browser si rimanda comunque a mano: chiunque abbia il link
 * puo' aprire gli strumenti per sviluppatori e inviare quello che vuole. Se il
 * blocco vive solo nella pagina, non e' un blocco — e' un suggerimento.
 *
 * Il campo che conta piu' di tutti e' **l'importo**. Se un ospite lo
 * "corregge", quella cifra finisce in fattura al posto di quella incassata, e
 * nessuno se ne accorge finche' non arriva il commercialista.
 */

import { COL_SOGGIORNI, COL_OSPITI } from './foglio-schema'

/** Chi sta scrivendo. */
export type Livello =
  /** Ingegnere o chi consegna le chiavi: puo' tutto. */
  | { tipo: 'gestore' }
  /** L'ospite intestatario: tutto tranne i campi della prenotazione. */
  | { tipo: 'prenotazione' }
  /** Un ospite qualsiasi: SOLO la propria scheda. */
  | { tipo: 'ospite'; progressivo: number }

/**
 * Campi che appartengono alla prenotazione, cioe' all'Ingegnere.
 *
 * Non e' un elenco di comodita': ognuno di questi, cambiato da un ospite,
 * produce un documento fiscale sbagliato o una comunicazione sbagliata alla
 * Questura.
 */
export const CAMPI_DELLA_PRENOTAZIONE: readonly string[] = [
  'ID Soggiorno',
  'Data registrazione',
  'Unità',
  'Portale',
  'Cod. prenotazione',
  'Check-in',
  'Check-out',
  'Notti',
  'N. ospiti',
  'Importo lordo €',
]

/**
 * Campi che l'ospite non deve nemmeno VEDERE.
 *
 * L'importo della prenotazione e' un dato commerciale fra l'Ingegnere e il
 * portale: quanto ha incassato, al netto o al lordo di cosa, non riguarda chi
 * dorme in casa — e mostrarlo apre discussioni che non servono a nessuno.
 *
 * Non basta non disegnarlo nella pagina: se il server lo manda, resta nella
 * risposta e si legge dagli strumenti del browser. Si toglie qui, prima di
 * uscire.
 */
export const CAMPI_RISERVATI: readonly string[] = [
  'Importo lordo €',
]

/**
 * I dati di CHI HA PRENOTATO. Il singolo ospite non deve vederli.
 *
 * Un audit del 6 settembre 2026 ha misurato la falla: si toglieva soltanto
 * l'importo, quindi il terzo ospite — spesso uno sconosciuto a cui il link
 * arriva su WhatsApp — riceveva codice fiscale, partita IVA, indirizzo, email e
 * telefono dell'intestatario. La pagina non li disegna, ma erano nella
 * risposta: si leggono dagli strumenti del browser, ed e' proprio la ragione
 * per cui questa mascheratura sta sul SERVER e non nell'interfaccia.
 *
 * Restano visibili a chi ha prenotato: quei campi li compila lui, e sono suoi.
 * Restano visibili a tutti l'unita', le date, le notti e — voluto —
 * l'IMPOSTA DI SOGGIORNO: e' quella che l'ospite paga in struttura, e sapere
 * quanto sara' gli serve per arrivare preparato.
 */
export const CAMPI_DELL_INTESTATARIO: readonly string[] = [
  'Intestatario fattura', 'Codice fiscale', 'P.IVA', 'Codice SDI / PEC',
  'Indirizzo', 'CAP', 'Città', 'Provincia', 'Nazione', 'Email', 'Telefono',
  'Note',
]

/**
 * Colonne della scheda ospite che il modulo NON scrive: le scrive il server.
 *
 * `Doc fronte` e `Doc retro` sono gli identificativi Drive delle foto, e li
 * mette la rotta di caricamento. Se li potesse scrivere chi compila, basterebbe
 * mandarli vuoti per svuotare la cella lasciando il file su Drive: il lavoro
 * notturno cancella solo cio' che trova NELLE CELLE, quindi quel documento
 * d'identita' resterebbe li' per sempre, invisibile a tutti.
 */
export const CAMPI_OSPITE_DI_SISTEMA: readonly string[] = [
  'ID Soggiorno',
  'Doc fronte',
  'Doc retro',
]

/** Toglie dalla mappa i campi che quel livello non deve vedere. */
export function oscuraRiservati(
  m: Record<string, string>,
  livello: Livello,
): Record<string, string> {
  if (livello.tipo === 'gestore') return m
  const out = { ...m }
  for (const c of CAMPI_RISERVATI) delete out[c]
  // Il singolo ospite vede la propria scheda e i dati del soggiorno, non
  // l'anagrafica fiscale di un'altra persona.
  if (livello.tipo === 'ospite') {
    for (const c of CAMPI_DELL_INTESTATARIO) delete out[c]
  }
  return out
}

/**
 * Campi che nessuno tocca dal form: li scrive il sistema.
 * Ci finiscono anche gli esiti della fatturazione: se il form potesse
 * riscriverli, un salvataggio tardivo cancellerebbe il numero di una fattura
 * gia' emessa.
 */
export const CAMPI_DEL_SISTEMA: readonly string[] = [
  'Imposta soggiorno €',
  'Inviato Alloggiati',
  'Fattura emessa',
  'N. fattura',
  'Data fattura',
  'ID documento FIC',
  'Stato check-in',
  'Da completare',
  'Stato fattura',
  'File Alloggiati del',
  // Lo scrive il server contando le schede compilate. Se lo mandasse il form,
  // chi compila potrebbe riscrivere il proprio conteggio — ed e' esattamente
  // il buco chiuso il 6 set 2026.
  'Ospiti dichiarati',
]

function indice(colonne: readonly string[], nome: string): number {
  return colonne.indexOf(nome)
}

/** Riga -> mappa nome colonna:valore. */
export function aMappa(colonne: readonly string[], riga: string[]): Record<string, string> {
  const m: Record<string, string> = {}
  colonne.forEach((c, i) => { m[c] = riga[i] ?? '' })
  return m
}

/** Mappa -> riga allineata allo schema. */
export function aRiga(colonne: readonly string[], m: Record<string, string>): string[] {
  return colonne.map((c) => m[c] ?? '')
}

export interface EsitoMerge {
  riga: string[]
  /** Campi che il mittente ha provato a cambiare senza averne diritto. */
  rifiutati: string[]
}

/**
 * Fonde la riga del soggiorno.
 *
 * I campi non consentiti non fanno fallire il salvataggio: vengono ignorati e
 * segnalati. Fallire vorrebbe dire bloccare un ospite in buona fede il cui
 * browser ha rimandato un campo invariato; ignorare in silenzio vorrebbe dire
 * non accorgersi mai di un tentativo vero.
 */
export function fondiSoggiorno(
  esistente: string[],
  inArrivo: Record<string, string>,
  livello: Livello,
): EsitoMerge {
  const attuale = aMappa(COL_SOGGIORNI, esistente)
  const nuova: Record<string, string> = { ...attuale }
  const rifiutati: string[] = []

  const bloccati = new Set<string>(CAMPI_DEL_SISTEMA)
  if (livello.tipo !== 'gestore') {
    for (const c of CAMPI_DELLA_PRENOTAZIONE) bloccati.add(c)
  }
  // Un ospite non intestatario non tocca NIENTE del soggiorno: ne' i dati della
  // prenotazione ne' quelli della fattura. Solo la propria scheda.
  const soloLaSuaScheda = livello.tipo === 'ospite'

  for (const [campo, valore] of Object.entries(inArrivo)) {
    if (indice(COL_SOGGIORNI, campo) < 0) continue // colonna che non esiste

    if (soloLaSuaScheda || bloccati.has(campo)) {
      // Rimandare invariato un campo bloccato e' normale: lo fa il browser.
      // Si segnala solo il tentativo di CAMBIARLO.
      if (String(valore ?? '') !== String(attuale[campo] ?? '')) rifiutati.push(campo)
      continue
    }
    nuova[campo] = String(valore ?? '')
  }

  return { riga: aRiga(COL_SOGGIORNI, nuova), rifiutati }
}

/**
 * Fonde le schede degli ospiti.
 *
 * Ogni scheda si aggiorna per (ID Soggiorno, Progressivo): non si cancella e
 * non si riscrive il blocco intero. Due ospiti possono compilare nello stesso
 * momento da telefoni diversi — riscrivere il blocco significherebbe che
 * l'ultimo dei due cancella il lavoro del primo.
 */
export function fondiOspiti(
  esistenti: string[][],
  inArrivo: Array<Record<string, string>>,
  livello: Livello,
  idSoggiorno: string,
  opzioni: { tolti?: string[] } = {},
): { righe: string[][]; rifiutati: string[]; tolti: string[] } {
  const rifiutati: string[] = []
  const tolti: string[] = []
  const perProgressivo = new Map<string, string[]>()
  for (const r of esistenti) {
    const m = aMappa(COL_OSPITI, r)
    // Con `trim`, e non senza: una cella `Progressivo` ritoccata a mano sul
    // foglio puo' contenere "2 ", e allora la chiave non corrisponderebbe a
    // quella che arriva dal modulo. Il risultato sarebbe una scheda cancellata
    // — con le sue foto — per colpa di uno spazio.
    perProgressivo.set(String(m['Progressivo'] ?? '').trim(), r)
  }

  /*
    TOGLIERE UN OSPITE: si dichiara UNO PER UNO, non si deduce dall'assenza.

    ── Storia, perche' e' costata due giri ─────────────────────────────────────
    Fino al 6 settembre 2026 il modulo, quando si premeva "rimuovi", non
    cancellava niente: RINUMERAVA. Con tre schede A, B, C, tolta la B, il
    browser rimandava "1=A, 2=C" e la riga 3 restava dov'era. Sul foglio
    finivano A, C, C — un ospite duplicato e uno sparito. E siccome le foto del
    documento non viaggiano col modulo, la riga fusa teneva IL NOME DI UNO E I
    DOCUMENTI DI UN ALTRO, e andava cosi' alla Questura.

    La prima cura fu dedurre le cancellazioni dall'elenco: "queste sono tutte
    le schede, le altre non ci sono piu'". Un audit avversariale l'ha rotta in
    due modi, tutti e due reali:

      1. Riusando un numero libero, il sostituto di un ospite disdetto prendeva
         la riga del disdetto — e con essa le SUE foto del documento. Lo stesso
         difetto di prima, entrato dalla porta di servizio.
      2. Una pagina aperta da mezz'ora "sa" solo gli ospiti che c'erano quando
         e' stata caricata. Se nel frattempo un altro ospite ha compilato la
         sua scheda, il salvataggio dell'intestatario la dichiarava assente e
         il server la cancellava, con le foto, senza chiedere niente.

    Cosi' la regola e' diventata: si cancella SOLO cio' che qualcuno ha
    esplicitamente tolto, e si cancella per numero. Chi non nomina un ospite
    non lo tocca — che e' anche l'unica regola compatibile con due persone che
    compilano la stessa pratica da due telefoni.

    Lo puo' fare solo chi ha titolo: l'intestatario o il gestore. Un singolo
    ospite non cancella le schede degli altri — e' la stessa regola per cui non
    puo' nemmeno leggerle.
  */
  const puoTogliere = livello.tipo === 'prenotazione' || livello.tipo === 'gestore'
  /*
    Una scheda che arriva NON si cancella, anche se qualcuno l'aveva chiesto.

    Le due cose insieme arrivano davvero: si toglie l'ospite 2, il salvataggio
    fallisce (una 429 di Google), la richiesta di rimozione resta in attesa, e
    intanto quella stessa scheda viene ricompilata. Senza questa riga la
    fusione restituiva il progressivo 2 sia fra le righe da scrivere sia fra
    quelle da cancellare: `salvaPratica` scriveva la riga e subito dopo la
    cancellava, con le foto del documento su Drive. E rispondeva `ok: true`.
  */
  const inArrivoOra = new Set(
    inArrivo.map((s) => String(s['Progressivo'] ?? '').trim()).filter(Boolean),
  )
  if (puoTogliere) {
    for (const chiesto of opzioni.tolti ?? []) {
      const prog = String(chiesto ?? '').trim()
      if (!prog || inArrivoOra.has(prog)) continue
      if (perProgressivo.delete(prog)) tolti.push(prog)
    }
  }

  for (const scheda of inArrivo) {
    const prog = String(scheda['Progressivo'] ?? '').trim()
    if (!prog) continue

    if (livello.tipo === 'ospite' && Number(prog) !== livello.progressivo) {
      rifiutati.push(`Ospite ${prog}`)
      continue
    }

    const attuale = perProgressivo.get(prog)
    const base = attuale ? aMappa(COL_OSPITI, attuale) : {}
    /*
      La stessa disciplina che vale per la riga della prenotazione vale per le
      schede: senza, `{ ...base, ...scheda }` accettava QUALUNQUE colonna
      arrivasse dal modulo.

      Trovato da due audit indipendenti il 6 settembre 2026. Il form e' pubblico:
      bastava una richiesta con `"Doc fronte": ""` per svuotare la cella
      lasciando il file su Drive — e il lavoro notturno cancella solo cio' che
      trova NELLE CELLE, quindi quel documento d'identita' sarebbe rimasto li'
      per sempre, invisibile a tutti.

      Il blocco stava solo nell'interfaccia (la casella nascosta nella pagina),
      ed e' esattamente la cosa che l'intestazione di questo file dichiara di
      non voler fare: cio' che non si deve poter cambiare si ferma sul SERVER.
    */
    const scheda2: Record<string, string> = {}
    for (const [campo, valore] of Object.entries(scheda)) {
      if (CAMPI_OSPITE_DI_SISTEMA.includes(campo)) {
        if (String(valore ?? '') !== String(base[campo] ?? '')) rifiutati.push(`${campo} (ospite ${prog})`)
        continue
      }
      scheda2[campo] = valore
    }
    const nuova: Record<string, string> = { ...base, ...scheda2 }
    // L'appartenenza non si sposta: un ospite non si trasferisce a un'altra
    // prenotazione riscrivendo un campo.
    nuova['ID Soggiorno'] = idSoggiorno
    nuova['Progressivo'] = prog
    perProgressivo.set(prog, aRiga(COL_OSPITI, nuova))
  }

  const righe = Array.from(perProgressivo.entries())
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, r]) => r)

  return { righe, rifiutati, tolti }
}
