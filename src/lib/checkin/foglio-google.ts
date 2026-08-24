/**
 * src/lib/checkin/foglio-google.ts
 *
 * L'adattatore vero fra `FoglioApi` e le API di Google Sheets.
 *
 * Deliberatamente sottile e senza un solo `catch`: se Google rifiuta, l'errore
 * deve arrivare fino a chi ha chiesto l'operazione. Gli helper generici di
 * `drive.ts` fanno il contrario — restituiscono il testo dell'errore come se
 * fosse un risultato — e in questo sottosistema non e' ammesso: un'operazione
 * fiscale che "riesce" restituendo una stringa d'errore e' peggio di una che
 * fallisce.
 */

import { getSheets } from '../drive'
import type { FoglioApi } from './foglio-init'

/**
 * Indice di colonna (0-based) -> lettera in notazione A1.
 * Oltre la 26esima diventa AA, AB...: la scheda Soggiorni ne ha gia' 30, quindi
 * un calcolo che si fermasse alla Z scriverebbe nel posto sbagliato.
 */
export function lettera(indice: number): string {
  let n = indice
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/** Mappa titolo -> sheetId numerico, che serve per formattare. */
async function proprietaSchede(spreadsheetId: string): Promise<Map<string, number>> {
  const sheets = await getSheets()
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  })
  const mappa = new Map<string, number>()
  for (const s of res.data.sheets ?? []) {
    const titolo = s.properties?.title
    const id = s.properties?.sheetId
    if (titolo != null && id != null) mappa.set(titolo, id)
  }
  return mappa
}

/**
 * Aggiunge righe in fondo a una scheda, SENZA lasciare che Google le interpreti.
 *
 * Il motivo e' un difetto trovato sul foglio VERO il 24/08, non in un test:
 * l'helper generico di drive.ts scrive con "USER_ENTERED", e allora Google
 * *legge* i valori invece di trascriverli. Il CAP "00100" era diventato il
 * numero 100, e il codice destinatario "0000000" era diventato "0" — cioe'
 * proprio il campo che instrada la fattura elettronica, svuotato in silenzio.
 *
 * Con "RAW" quello che si scrive e' quello che resta.
 */
export async function aggiungiRighe(
  spreadsheetId: string,
  nomeScheda: string,
  righe: string[][],
): Promise<void> {
  if (righe.length === 0) return
  const sheets = await getSheets()
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${nomeScheda}'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: righe },
  })
}

/** Tutte le righe di una scheda, intestazione compresa. */
export async function leggiTutto(spreadsheetId: string, nomeScheda: string): Promise<string[][]> {
  const sheets = await getSheets()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${nomeScheda}'!A:AZ`,
  })
  return (res.data.values ?? []).map((r) => (r ?? []).map((c) => String(c ?? '')))
}

/**
 * Riscrive UNA riga, individuata dal suo numero (1-based, intestazione inclusa).
 *
 * Si riscrive la riga intera e non le singole celle cambiate: cosi' la riga sul
 * foglio corrisponde sempre, colonna per colonna, a quella che il codice ha
 * costruito. Aggiornare celle sparse lascerebbe combinazioni che nessuno ha mai
 * prodotto — e sono quelle che poi non si sanno spiegare.
 */
export async function aggiornaRiga(
  spreadsheetId: string,
  nomeScheda: string,
  numeroRiga: number,
  valori: string[],
): Promise<void> {
  const sheets = await getSheets()
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${nomeScheda}'!A${numeroRiga}`,
    valueInputOption: 'RAW',
    requestBody: { values: [valori] },
  })
}

export const foglioGoogle: FoglioApi = {
  async elencaSchede(spreadsheetId) {
    return Array.from((await proprietaSchede(spreadsheetId)).keys())
  },

  async creaScheda(spreadsheetId, nome) {
    const sheets = await getSheets()
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: nome } } }] },
    })
  },

  async leggiPrimaRiga(spreadsheetId, nome) {
    const sheets = await getSheets()
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${nome}'!1:1`,
    })
    return (res.data.values?.[0] ?? []).map(String)
  },

  async scrivi(spreadsheetId, nome, valori) {
    const sheets = await getSheets()
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${nome}'!A1`,
      // RAW e non USER_ENTERED: le intestazioni devono restare testo esatto.
      // Con USER_ENTERED, Google interpreta e un valore come "01/05" diventa
      // una data — e il Config smetterebbe di dire quello che c'e' scritto.
      valueInputOption: 'RAW',
      requestBody: { values: valori },
    })
  },

  async scriviIntestazioniInCoda(spreadsheetId, nome, daColonna, intestazioni) {
    if (intestazioni.length === 0) return
    const sheets = await getSheets()

    // Una scheda ha un numero FISSO di colonne di griglia. Scrivere oltre non
    // e' "aggiungere una colonna", e' uscire dal foglio: Google risponde
    // "exceeds grid limits" e non scrive niente. Trovato sul foglio vero il
    // 24/08, con 28 colonne esatte e la 29esima da creare.
    const serve = daColonna + intestazioni.length
    const info = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties(sheetId,title,gridProperties/columnCount)',
    })
    const prop = (info.data.sheets ?? [])
      .map((s) => s.properties)
      .find((p) => p?.title === nome)
    if (!prop?.sheetId && prop?.sheetId !== 0) throw new Error(`Scheda "${nome}" non trovata.`)

    const attuali = prop.gridProperties?.columnCount ?? 0
    if (attuali < serve) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            appendDimension: { sheetId: prop.sheetId, dimension: 'COLUMNS', length: serve - attuali },
          }],
        },
      })
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${nome}'!${lettera(daColonna)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[...intestazioni]] },
    })
  },

  async congelaIntestazione(spreadsheetId, nome) {
    const sheets = await getSheets()
    const sheetId = (await proprietaSchede(spreadsheetId)).get(nome)
    if (sheetId == null) throw new Error(`Scheda "${nome}" non trovata dopo la creazione.`)

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.122, green: 0.22, blue: 0.392 }, // #1f3864
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
        ],
      },
    })
  },
}
