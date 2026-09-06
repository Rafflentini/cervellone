/**
 * src/lib/checkin/pratica.ts
 *
 * La pratica di check-in sul foglio: crearla, leggerla, aggiornarla.
 *
 * Tutto passa di qui, e in un punto solo, perche' il foglio non ha transazioni:
 * ogni scrittura sparsa in giro sarebbe un modo diverso di lasciarlo a meta'.
 */

import {
  FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI, SCHEDA_OSPITI, COL_SOGGIORNI, COL_OSPITI,
} from './foglio-schema'
import { leggiTutto, aggiornaRiga, aggiungiRighe, eliminaRighe } from './foglio-google'
import { aMappa, aRiga, fondiSoggiorno, fondiOspiti, type Livello } from './merge-pratica'
import { calcolaStato } from './stato-checkin'
import { leggiConfig, regoleDaConfig } from './foglio-lettura'
import { calcolaImpostaSoggiorno } from './imposta-soggiorno'
import { eliminaDocumento } from './documenti'

export interface Pratica {
  id: string
  /** Numero di riga sul foglio, 1-based, intestazione inclusa. */
  numeroRiga: number
  soggiorno: Record<string, string>
  /** Schede ospiti, col numero di riga di ciascuna. */
  ospiti: Array<{ numeroRiga: number; dati: Record<string, string> }>
}

const idDi = (riga: string[]) => String(riga[0] ?? '').trim()

export async function leggiPratica(
  id: string,
  spreadsheetId: string = FOGLIO_CHECKIN_ID,
): Promise<Pratica | null> {
  const [soggiorni, ospiti] = await Promise.all([
    leggiTutto(spreadsheetId, SCHEDA_SOGGIORNI),
    leggiTutto(spreadsheetId, SCHEDA_OSPITI),
  ])

  // i=0 e' l'intestazione; il numero di riga sul foglio e' i+1.
  const i = soggiorni.findIndex((r, idx) => idx > 0 && idDi(r) === id)
  if (i < 0) return null

  return {
    id,
    numeroRiga: i + 1,
    soggiorno: aMappa(COL_SOGGIORNI, soggiorni[i]),
    ospiti: ospiti
      .map((r, idx) => ({ idx, r }))
      .filter(({ idx, r }) => idx > 0 && idDi(r) === id)
      .map(({ idx, r }) => ({ numeroRiga: idx + 1, dati: aMappa(COL_OSPITI, r) })),
  }
}

/** Genera l'identificativo: leggibile a occhio e ordinabile come testo. */
export function nuovoIdSoggiorno(ora: Date): string {
  const due = (n: number) => String(n).padStart(2, '0')
  return (
    'SOG-' + ora.getUTCFullYear() + due(ora.getUTCMonth() + 1) + due(ora.getUTCDate()) +
    '-' + due(ora.getUTCHours()) + due(ora.getUTCMinutes()) + due(ora.getUTCSeconds())
  )
}

export interface DatiPrenotazione {
  /** Dell ospite che ha prenotato: servono a fargli arrivare il link. */
  telefono?: string
  email?: string
  unita: string
  portale: string
  codPrenotazione: string
  checkin: string
  checkout: string
  ospitiAttesi: string
  importoLordo: string
  intestatario: string
  note: string
}

/**
 * Crea la pratica con i pochi dati che l'Ingegnere ha in mano alla
 * prenotazione. Tutto il resto lo compileranno gli ospiti.
 */
export async function creaPrenotazione(
  d: DatiPrenotazione,
  ora: Date,
  spreadsheetId: string = FOGLIO_CHECKIN_ID,
): Promise<{ id: string }> {
  const id = nuovoIdSoggiorno(ora)
  const pulito = (v: string) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim()

  /*
    Notti e imposta si calcolano SUBITO, alla creazione.

    Prima restavano vuote fino al primo salvataggio delle schede ospite. Il
    riquadro "Imposta di soggiorno" leggeva quelle celle, e una prenotazione
    appena inserita valeva zero: registrando gli arretrati di agosto — venti
    prenotazioni, nessuna scheda ancora compilata — il totale da versare al
    Comune entro il 16 diceva "0 notti · € 0,00". Un numero fiscale
    sistematicamente a zero, e nessuna riga a schermo che lo dicesse.

    Trovato provando in produzione la stessa sequenza che fara' domani chi
    inserisce gli arretrati, non leggendo il codice.

    Il conto e' quello di `salvaPratica`: le persone PRENOTATE, perche' chi ha
    dormito qui deve l'imposta anche se non ha ancora consegnato i suoi dati.
    Al primo salvataggio il numero viene ricalcolato con le esenzioni vere.
  */
  const attesi = Math.max(Number(pulito(d.ospitiAttesi) || 0), 0)
  const imposta = calcolaImpostaSoggiorno({
    checkin: pulito(d.checkin),
    checkout: pulito(d.checkout),
    regole: regoleDaConfig(await leggiConfig(spreadsheetId)),
    ospiti: Array.from({ length: attesi }, () => ({
      dataNascita: '', esente: false, motivoEsenzione: '',
    })),
  })

  const riga = aRiga(COL_SOGGIORNI, {
    'ID Soggiorno': id,
    'Data registrazione': ora.toISOString(),
    'Unità': pulito(d.unita),
    'Portale': pulito(d.portale),
    'Cod. prenotazione': pulito(d.codPrenotazione),
    'Check-in': pulito(d.checkin),
    'Check-out': pulito(d.checkout),
    'N. ospiti': pulito(d.ospitiAttesi),
    'Importo lordo €': pulito(d.importoLordo).replace(',', '.'),
    'Intestatario fattura': pulito(d.intestatario).toUpperCase(),
    'Nazione': 'IT',
    'Inviato Alloggiati': 'NO',
    'Fattura emessa': 'NO',
    'Stato fattura': 'DA FARE',
    'Telefono': pulito(d.telefono ?? ''),
    'Email': pulito(d.email ?? ''),
    'Note': pulito(d.note),
    'Stato check-in': 'DA COMPILARE',
    'Notti': String(imposta.notti),
    'Imposta soggiorno €': String(imposta.importo),
    'Ospiti dichiarati': pulito(d.ospitiAttesi),
    'Da completare': 'Nessuno ha ancora compilato.',
  })

  await aggiungiRighe(spreadsheetId, SCHEDA_SOGGIORNI, [riga])
  return { id }
}

/**
 * Elimina una pratica e tutte le sue schede ospite.
 *
 * Serve davvero: le prenotazioni si disdicono. E serve che tolga ANCHE gli
 * ospiti — una scheda orfana resterebbe nel foglio con i dati di una persona
 * che non verra' mai, cioe' dati personali conservati senza piu' uno scopo.
 *
 * Rifiuta di cancellare una pratica gia' fatturata: un documento fiscale
 * emesso deve poter essere ricondotto alla riga che lo ha generato.
 */
/** Gli identificativi delle foto di una pratica, senza i vuoti. */
export function documentiDi(pratica: Pratica): string[] {
  return pratica.ospiti
    .flatMap((o) => [o.dati['Doc fronte'], o.dati['Doc retro']])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
}

/**
 * Toglie da Drive tutte le foto di una pratica.
 *
 * Non si ferma al primo errore: se una foto non si cancella, le altre devono
 * sparire lo stesso. Fermarsi vorrebbe dire lasciarne dieci per colpa di una.
 */
export async function eliminaDocumentiDi(pratica: Pratica): Promise<number> {
  let tolte = 0
  for (const fileId of documentiDi(pratica)) {
    try {
      if (await eliminaDocumento(fileId)) tolte++
    } catch (err) {
      console.error('[CHECKIN] foto non cancellata:', err instanceof Error ? err.message : 'errore')
    }
  }
  return tolte
}

export async function eliminaPratica(
  id: string,
  spreadsheetId: string = FOGLIO_CHECKIN_ID,
): Promise<{ ok: boolean; errore?: string; righeTolte?: number; fotoTolte?: number }> {
  const pratica = await leggiPratica(id, spreadsheetId)
  if (!pratica) return { ok: false, errore: 'Prenotazione non trovata.' }

  if (String(pratica.soggiorno['Fattura emessa'] ?? '').toUpperCase() === 'SI') {
    return {
      ok: false,
      errore: 'Questa prenotazione ha gia una fattura: la riga non si cancella, si annulla con nota di credito.',
    }
  }

  // PRIMA le foto, poi le righe. Cancellando prima le righe si perderebbero
  // gli identificativi dei file, e quelle foto resterebbero su Drive per
  // sempre senza che nessuno sappia piu' a chi appartengono: un archivio di
  // documenti d'identita' orfani, che e' il peggiore dei casi.
  const fotoTolte = await eliminaDocumentiDi(pratica)

  const righeOspiti = pratica.ospiti.map((o) => o.numeroRiga)
  await eliminaRighe(spreadsheetId, SCHEDA_OSPITI, righeOspiti)
  await eliminaRighe(spreadsheetId, SCHEDA_SOGGIORNI, [pratica.numeroRiga])

  return { ok: true, righeTolte: righeOspiti.length + 1, fotoTolte }
}

export interface EsitoSalvataggio {
  ok: boolean
  stato: string
  mancanze: string[]
  segnalazioni: string[]
  /** Campi che il mittente non aveva diritto di cambiare. */
  rifiutati: string[]
}

/**
 * Salva quello che e' stato compilato, per quel che il livello consente, e
 * ricalcola stato e imposta.
 *
 * L'imposta si ricalcola SEMPRE qui e mai dal form: e' l'unica cifra di questo
 * sistema che finisce in un versamento a un Comune, e non deve dipendere da
 * cosa ha inviato un browser.
 */
export async function salvaPratica(
  id: string,
  soggiornoInArrivo: Record<string, string>,
  ospitiInArrivo: Array<Record<string, string>>,
  livello: Livello,
  spreadsheetId: string = FOGLIO_CHECKIN_ID,
  opzioni: { tolti?: string[] } = {},
): Promise<EsitoSalvataggio | null> {
  const pratica = await leggiPratica(id, spreadsheetId)
  if (!pratica) return null

  const rigaAttuale = aRiga(COL_SOGGIORNI, pratica.soggiorno)
  const fusoSoggiorno = fondiSoggiorno(rigaAttuale, soggiornoInArrivo, livello)

  const righeOspitiAttuali = pratica.ospiti.map((o) => aRiga(COL_OSPITI, o.dati))
  const fusiOspiti = fondiOspiti(righeOspitiAttuali, ospitiInArrivo, livello, id, opzioni)

  const mappaSoggiorno = aMappa(COL_SOGGIORNI, fusoSoggiorno.riga)
  const schede = fusiOspiti.righe.map((r) => aMappa(COL_OSPITI, r))

  // Imposta e stato: calcolati qui, mai accettati dal form.
  const cfg = await leggiConfig(spreadsheetId)

  /*
    L'imposta si calcola sulle persone PRENOTATE, non sulle schede compilate.

    Chi ha dormito qui deve l'imposta anche se non ha ancora consegnato i
    propri dati: il Comune non chiede quante schede sono state compilate.
    Quindi alle schede vere si aggiungono tanti "adulti senza dati" quanti
    mancano per arrivare a `N. ospiti` — che e' il numero che imposta chi
    gestisce, e l'unico metro di questo sistema.

    Prima il conto tornava per caso: il modulo mandava anche le schede bianche,
    e una data di nascita vuota veniva contata come pagante. Smettendo di
    scrivere quelle righe — che sporcavano il file per la Questura — l'imposta
    sarebbe silenziosamente calata. Qui la ragione e' scritta, invece che
    affidata a un effetto collaterale.

    Al ribasso non si va mai: se le schede fossero PIU' degli attesi, valgono
    le schede.
  */
  const attesiPerImposta = Number(mappaSoggiorno['N. ospiti'] || 0)
  const ospitiPerImposta = [
    ...schede.map((s) => ({
      dataNascita: s['Data nascita'] ?? '',
      esente: String(s['Esente imposta'] ?? '').toUpperCase() === 'SI',
      motivoEsenzione: s['Motivo esenzione'] ?? '',
    })),
    ...Array.from({ length: Math.max(0, attesiPerImposta - schede.length) }, () => ({
      dataNascita: '',
      esente: false,
      motivoEsenzione: '',
    })),
  ]

  const imposta = calcolaImpostaSoggiorno({
    checkin: mappaSoggiorno['Check-in'],
    checkout: mappaSoggiorno['Check-out'],
    regole: regoleDaConfig(cfg),
    ospiti: ospitiPerImposta,
  })

  const stato = calcolaStato({
    ospitiAttesi: Number(mappaSoggiorno['N. ospiti'] || 0),
    ospitiDichiarati: Number(mappaSoggiorno['Ospiti dichiarati'] || 0),
    ospiti: schede.map((s) => ({
      cognome: s['Cognome'] ?? '', nome: s['Nome'] ?? '',
      dataNascita: s['Data nascita'] ?? '',
      comuneNascita: s['Comune nascita'] ?? '', statoNascita: s['Stato nascita'] ?? '',
      cittadinanza: s['Cittadinanza'] ?? '',
      tipoDocumento: s['Tipo documento'] ?? '', numeroDocumento: s['Numero documento'] ?? '',
      codiceFiscale: s['Codice fiscale'] ?? '',
    })),
    indirizzo: mappaSoggiorno['Indirizzo'] ?? '',
    cap: mappaSoggiorno['CAP'] ?? '',
    citta: mappaSoggiorno['Città'] ?? '',
    nazione: mappaSoggiorno['Nazione'] ?? 'IT',
  })

  // Quante schede risultano DAVVERO compilate. Lo scrive il server contando,
  // non il browser dichiarando: fino al 6 settembre 2026 era il form a mandare
  // questo numero, ed era anche il metro con cui si stabiliva se il check-in
  // fosse completo — cioe' chi veniva misurato forniva il metro.
  // Ora e' un dato di cronaca, non un controllo: il metro e' `N. ospiti`, che
  // imposta il gestore. Vedi `calcolaStato`.
  mappaSoggiorno['Ospiti dichiarati'] = String(
    schede.filter((s) => `${s['Cognome'] ?? ''}${s['Nome'] ?? ''}${s['Data nascita'] ?? ''}`.trim()).length,
  )
  mappaSoggiorno['Notti'] = String(imposta.notti)
  mappaSoggiorno['Imposta soggiorno €'] = String(imposta.importo)
  mappaSoggiorno['Stato check-in'] = stato.stato
  mappaSoggiorno['Da completare'] = [...stato.mancanze, ...stato.segnalazioni].join(' · ')

  // Prima gli ospiti, poi il soggiorno: se la seconda scrittura non riesce,
  // restano schede senza uno stato aggiornato — visibile e recuperabile.
  // Nell'ordine opposto lo stato direbbe CHECKIN OK su schede non salvate.
  const perProgressivo = new Map(pratica.ospiti.map((o) => [String(o.dati['Progressivo']).trim(), o.numeroRiga]))
  const daAggiungere: string[][] = []
  for (const riga of fusiOspiti.righe) {
    const prog = String(aMappa(COL_OSPITI, riga)['Progressivo'])
    const n = perProgressivo.get(prog)
    if (n) await aggiornaRiga(spreadsheetId, SCHEDA_OSPITI, n, riga)
    else daAggiungere.push(riga)
  }
  await aggiungiRighe(spreadsheetId, SCHEDA_OSPITI, daAggiungere)

  /*
    Le schede tolte vanno cancellate DAVVERO dal foglio.

    Omettere una riga dal risultato della fusione non la fa sparire: resterebbe
    dov'e', con i dati di una persona che non viene piu' — e finirebbe nel file
    per la Questura e nel conteggio dell'imposta. Dati personali conservati
    senza piu' uno scopo, e un ospite comunicato che non ha dormito li'.

    Prima le foto del documento, poi la riga: cancellando prima la riga si
    perderebbero gli identificativi dei file e quelle foto resterebbero su
    Drive per sempre, senza che nessuno sappia piu' a chi appartengono.
    Si cancella dal numero di riga piu' alto al piu' basso, altrimenti la prima
    cancellazione sposta in su tutte le successive.
  */
  if (fusiOspiti.tolti.length > 0) {
    const daTogliere = pratica.ospiti.filter((o) => fusiOspiti.tolti.includes(String(o.dati['Progressivo']).trim()))
    for (const o of daTogliere) {
      for (const fileId of [o.dati['Doc fronte'], o.dati['Doc retro']].map((x) => String(x ?? '').trim()).filter(Boolean)) {
        try {
          await eliminaDocumento(fileId)
        } catch (err) {
          console.error('[CHECKIN] foto di ospite tolto non cancellata:', err instanceof Error ? err.message : 'errore')
        }
      }
    }
    await eliminaRighe(
      spreadsheetId,
      SCHEDA_OSPITI,
      daTogliere.map((o) => o.numeroRiga).sort((a, b) => b - a),
    )
  }

  await aggiornaRiga(spreadsheetId, SCHEDA_SOGGIORNI, pratica.numeroRiga, aRiga(COL_SOGGIORNI, mappaSoggiorno))

  return {
    ok: true,
    stato: stato.stato,
    mancanze: stato.mancanze,
    /*
      Le anomalie del calcolo dell'imposta risalgono fino a chi compila.

      `imposta-soggiorno.ts` dichiara che "in questo sottosistema niente puo'
      fallire in silenzio", ma qui il risultato veniva letto solo per l'importo
      e le anomalie sparivano: un'esenzione senza motivo dichiarato — che in
      sede di controllo e' un ammanco — non arrivava a nessuno.
    */
    segnalazioni: [...stato.segnalazioni, ...imposta.anomalie],
    rifiutati: [...fusoSoggiorno.rifiutati, ...fusiOspiti.rifiutati],
  }
}

/**
 * Scrive alcune celle sulla riga di un soggiorno, lasciando intatto il resto.
 *
 * Serve alle SEGNATURE: "file per la Questura generato il ...", "fattura
 * emessa". Non passa da `salvaPratica` di proposito — quella ricalcola stato,
 * imposta e mancanze, e ricalcolare tutto per spuntare una casella vuol dire
 * dare a un gesto minimo la possibilita' di riscrivere una pratica intera.
 *
 * Si riscrive la RIGA per intero, come ovunque qui dentro: cosi' i campi che
 * devono restare coerenti fra loro — `Stato fattura` e `Fattura emessa` —
 * partono nella stessa scrittura e non possono divergere.
 */
export async function segnaSoggiorno(
  id: string,
  campi: Record<string, string>,
  spreadsheetId: string = FOGLIO_CHECKIN_ID,
): Promise<{ ok: boolean; errore?: string }> {
  const pratica = await leggiPratica(id, spreadsheetId)
  if (!pratica) return { ok: false, errore: `Prenotazione ${id} non trovata.` }

  const mappa = { ...pratica.soggiorno, ...campi }
  await aggiornaRiga(spreadsheetId, SCHEDA_SOGGIORNI, pratica.numeroRiga, aRiga(COL_SOGGIORNI, mappa))
  return { ok: true }
}
