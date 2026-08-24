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
import { leggiTutto, aggiornaRiga, aggiungiRighe } from './foglio-google'
import { aMappa, aRiga, fondiSoggiorno, fondiOspiti, type Livello } from './merge-pratica'
import { calcolaStato } from './stato-checkin'
import { leggiConfig, regoleDaConfig } from './foglio-lettura'
import { calcolaImpostaSoggiorno } from './imposta-soggiorno'

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
    'Note': pulito(d.note),
    'Stato check-in': 'DA COMPILARE',
    'Da completare': 'Nessuno ha ancora compilato.',
  })

  await aggiungiRighe(spreadsheetId, SCHEDA_SOGGIORNI, [riga])
  return { id }
}

export interface EsitoSalvataggio {
  ok: boolean
  stato: string
  mancanze: string[]
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
): Promise<EsitoSalvataggio | null> {
  const pratica = await leggiPratica(id, spreadsheetId)
  if (!pratica) return null

  const rigaAttuale = aRiga(COL_SOGGIORNI, pratica.soggiorno)
  const fusoSoggiorno = fondiSoggiorno(rigaAttuale, soggiornoInArrivo, livello)

  const righeOspitiAttuali = pratica.ospiti.map((o) => aRiga(COL_OSPITI, o.dati))
  const fusiOspiti = fondiOspiti(righeOspitiAttuali, ospitiInArrivo, livello, id)

  const mappaSoggiorno = aMappa(COL_SOGGIORNI, fusoSoggiorno.riga)
  const schede = fusiOspiti.righe.map((r) => aMappa(COL_OSPITI, r))

  // Imposta e stato: calcolati qui, mai accettati dal form.
  const cfg = await leggiConfig(spreadsheetId)
  const imposta = calcolaImpostaSoggiorno({
    checkin: mappaSoggiorno['Check-in'],
    checkout: mappaSoggiorno['Check-out'],
    regole: regoleDaConfig(cfg),
    ospiti: schede.map((s) => ({
      dataNascita: s['Data nascita'] ?? '',
      esente: String(s['Esente imposta'] ?? '').toUpperCase() === 'SI',
      motivoEsenzione: s['Motivo esenzione'] ?? '',
    })),
  })

  const stato = calcolaStato({
    ospitiAttesi: Number(mappaSoggiorno['N. ospiti'] || 0),
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

  mappaSoggiorno['Notti'] = String(imposta.notti)
  mappaSoggiorno['Imposta soggiorno €'] = String(imposta.importo)
  mappaSoggiorno['Stato check-in'] = stato.stato
  mappaSoggiorno['Da completare'] = stato.mancanze.join(' · ')

  // Prima gli ospiti, poi il soggiorno: se la seconda scrittura non riesce,
  // restano schede senza uno stato aggiornato — visibile e recuperabile.
  // Nell'ordine opposto lo stato direbbe CHECKIN OK su schede non salvate.
  const perProgressivo = new Map(pratica.ospiti.map((o) => [String(o.dati['Progressivo']), o.numeroRiga]))
  const daAggiungere: string[][] = []
  for (const riga of fusiOspiti.righe) {
    const prog = String(aMappa(COL_OSPITI, riga)['Progressivo'])
    const n = perProgressivo.get(prog)
    if (n) await aggiornaRiga(spreadsheetId, SCHEDA_OSPITI, n, riga)
    else daAggiungere.push(riga)
  }
  await aggiungiRighe(spreadsheetId, SCHEDA_OSPITI, daAggiungere)

  await aggiornaRiga(spreadsheetId, SCHEDA_SOGGIORNI, pratica.numeroRiga, aRiga(COL_SOGGIORNI, mappaSoggiorno))

  return {
    ok: true,
    stato: stato.stato,
    mancanze: stato.mancanze,
    rifiutati: [...fusoSoggiorno.rifiutati, ...fusiOspiti.rifiutati],
  }
}
