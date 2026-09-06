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
 * Quante volte si riprova, e quanto si aspetta fra un tentativo e l'altro.
 * Tre tentativi in tutto: nel caso peggiore si aggiunge un secondo e mezzo a
 * un salvataggio. Di piu' vorrebbe dire far aspettare davanti a uno schermo
 * qualcuno che non sa cosa stia succedendo.
 */
const ATTESE_MS = [400, 1200]

/** Lo stato HTTP di un errore di Google, comunque sia confezionato. */
function statoDi(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; status?: number; code?: unknown }
  const n = e?.response?.status ?? e?.status ?? (typeof e?.code === 'number' ? e.code : undefined)
  return typeof n === 'number' ? n : undefined
}

/** Un guasto di rete: la richiesta puo' essere arrivata, o no. Non si sa. */
function guastoDiRete(err: unknown): boolean {
  const codice = String((err as { code?: unknown })?.code ?? '')
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(codice)
}

/**
 * Riprova un'operazione sul foglio.
 *
 * ── Perche' esiste (6 settembre 2026) ────────────────────────────────────────
 * Un "withRetry" c'era gia' in lib/resilience.ts, e non era chiamato da
 * nessuna parte. Anche chiamandolo non avrebbe ritentato niente: cerca lo
 * stato in "err.error.status", che e' la forma di Anthropic e non quella di
 * Google. Codice morto che somigliava a una difesa.
 *
 * Intanto la libreria di Google ritenta per conto suo le GET e le PUT, ma NON
 * le POST: cioe' proprio "append" (la prima volta che si salva la scheda di un
 * ospite) e "batchUpdate" (la cancellazione). Una 429 li' faceva fallire il
 * salvataggio con "Non sono riuscito a salvare. Riprova." mentre tutto il
 * resto si autoriparava — e da fuori sembra un programma che funziona a
 * giorni alterni.
 *
 * ── La distinzione che conta ─────────────────────────────────────────────────
 * `ripetibile` dice se l'operazione si puo' rifare a scatola chiusa.
 *
 *   'sempre'        lettura, o riscrittura di una riga precisa: rifarla due
 *                   volte lascia lo stesso risultato. Si riprova anche se la
 *                   connessione cade a meta', perche' nel dubbio ripetere non
 *                   fa danno.
 *
 *   'solo-rifiuti'  aggiunta in fondo, o cancellazione: rifarle DUPLICA o
 *                   cancella due volte. Qui si riprova SOLO quando Google ha
 *                   detto esplicitamente "no, riprova" (429 troppe richieste,
 *                   503 non disponibile): quel no significa che la richiesta
 *                   e' stata respinta, non applicata. Se invece cade la rete
 *                   non si sa se sia arrivata, e allora si preferisce un
 *                   errore visibile a un ospite scritto due volte.
 */
export async function conRipetizione<T>(
  ripetibile: 'sempre' | 'solo-rifiuti',
  fn: () => Promise<T>,
): Promise<T> {
  for (let tentativo = 0; ; tentativo++) {
    try {
      return await fn()
    } catch (err) {
      const stato = statoDi(err)
      const rifiutata = stato === 429 || stato === 503
      const vaRipetuta = rifiutata || (ripetibile === 'sempre' && (guastoDiRete(err) || stato === 500))

      if (!vaRipetuta || tentativo >= ATTESE_MS.length) throw err

      // Un pizzico di casualita': se due telefoni prendono la stessa 429,
      // riprovare entrambi nello stesso istante la rimedia uguale.
      const attesa = ATTESE_MS[tentativo] + Math.floor(Math.random() * 250)
      console.warn('[CHECKIN] foglio: ' + (stato ?? 'rete') + ', riprovo fra ' + attesa + 'ms')
      await new Promise((r) => setTimeout(r, attesa))
    }
  }
}

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
  // 'solo-rifiuti': ripetere un append che era gia' arrivato scriverebbe gli
  // stessi ospiti una seconda volta, in fondo al foglio.
  await conRipetizione('solo-rifiuti', () => sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${nomeScheda}'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: righe },
  }))
}

/** Tutte le righe di una scheda, intestazione compresa. */
export async function leggiTutto(spreadsheetId: string, nomeScheda: string): Promise<string[][]> {
  const sheets = await getSheets()
  const res = await conRipetizione('sempre', () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${nomeScheda}'!A:AZ`,
  }))
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
  // 'sempre': riscrivere la stessa riga con gli stessi valori due volte lascia
  // il foglio identico.
  await conRipetizione('sempre', () => sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${nomeScheda}'!A${numeroRiga}`,
    valueInputOption: 'RAW',
    requestBody: { values: [valori] },
  }))
}

/**
 * Elimina righe da una scheda, indicate col numero 1-based.
 *
 * Si cancella DAL BASSO VERSO L'ALTO. Togliendo prima la riga 5 e poi la 9, la
 * 9 nel frattempo e' diventata l'8 e si cancellerebbe la riga sbagliata — che
 * qui vuol dire l'ospite di un'altra prenotazione. E' l'errore classico, non si
 * vede nei test con una riga sola, e non lascia traccia di cosa e' sparito.
 */
export async function eliminaRighe(
  spreadsheetId: string,
  nomeScheda: string,
  numeriRiga: number[],
): Promise<number> {
  if (numeriRiga.length === 0) return 0
  const sheets = await getSheets()
  const sheetId = (await proprietaSchede(spreadsheetId)).get(nomeScheda)
  if (sheetId == null) throw new Error(`Scheda "${nomeScheda}" non trovata.`)

  const ordinate = Array.from(new Set(numeriRiga)).sort((a, b) => b - a)
  // 'solo-rifiuti': ripetere una cancellazione gia' avvenuta toglierebbe le
  // righe che nel frattempo hanno preso quei numeri — cioe' gli ospiti di
  // un'altra prenotazione.
  await conRipetizione('solo-rifiuti', () => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: ordinate.map((n) => ({
        deleteDimension: {
          // startIndex e' 0-based ed esclude l'estremo finale: la riga N del
          // foglio e' l'indice N-1.
          range: { sheetId, dimension: 'ROWS', startIndex: n - 1, endIndex: n },
        },
      })),
    },
  }))
  return ordinate.length
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

  async leggiColonna(spreadsheetId, nome, indice) {
    const righe = await leggiTutto(spreadsheetId, nome)
    return righe.slice(1).map((r) => String(r[indice] ?? ''))
  },

  async aggiungiInFondo(spreadsheetId, nome, righe) {
    await aggiungiRighe(spreadsheetId, nome, righe)
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
