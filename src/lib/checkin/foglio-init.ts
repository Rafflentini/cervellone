/**
 * src/lib/checkin/foglio-init.ts
 *
 * Porta le quattro schede sul foglio di check-in, sul foglio che gia' esiste.
 *
 * Perche' non un menu da cliccare: l'app Apps Script di agosto aveva una voce
 * "Inizializza foglio" e nessuno l'ha mai premuta — per due settimane il foglio
 * e' rimasto vuoto e il progetto fermo, senza che niente segnalasse nulla. Un
 * passaggio che dipende da un gesto umano ricordato a memoria non e' un
 * passaggio: e' un punto in cui il sistema si ferma.
 *
 * Due proprieta' non negoziabili:
 *
 *  - **Ripetibile senza danno.** Rieseguirla su un foglio gia' in uso non tocca
 *    un solo dato. Scrive l'intestazione SOLO in una scheda vuota.
 *  - **Non fallisce in silenzio.** Se una scheda non si crea, l'esito lo dice e
 *    dice fin dove era arrivata.
 */

import {
  schedeDelFoglio, FOGLIO_CHECKIN_ID,
} from './foglio-schema'

/**
 * Il minimo che serve per operare su un foglio. Un'interfaccia stretta invece
 * del client Google intero: cosi' la logica si prova senza rete, e l'adattatore
 * vero resta cosi' sottile da non poter nascondere errori.
 */
export interface FoglioApi {
  elencaSchede(spreadsheetId: string): Promise<string[]>
  creaScheda(spreadsheetId: string, nome: string): Promise<void>
  leggiPrimaRiga(spreadsheetId: string, nome: string): Promise<string[]>
  scrivi(spreadsheetId: string, nome: string, valori: string[][]): Promise<void>
  congelaIntestazione(spreadsheetId: string, nome: string): Promise<void>
}

export interface EsitoInizializzazione {
  ok: boolean
  /** Schede create adesso. */
  create: string[]
  /** Schede che c'erano gia', con la loro intestazione: non toccate. */
  giaPronte: string[]
  errore?: string
}

export async function inizializzaFoglioCheckin(
  spreadsheetId: string = FOGLIO_CHECKIN_ID,
  api: FoglioApi,
): Promise<EsitoInizializzazione> {
  const create: string[] = []
  const giaPronte: string[] = []

  try {
    const esistenti = new Set(await api.elencaSchede(spreadsheetId))

    for (const scheda of schedeDelFoglio()) {
      if (!esistenti.has(scheda.nome)) {
        await api.creaScheda(spreadsheetId, scheda.nome)
        create.push(scheda.nome)
      }

      // L'intestazione si scrive solo se la scheda e' vuota. Una scheda con
      // gia' dei dati non si tocca: e' li' che vivrebbero i soggiorni di una
      // stagione avviata.
      const prima = await api.leggiPrimaRiga(spreadsheetId, scheda.nome)
      if (prima.length > 0) {
        if (!create.includes(scheda.nome)) giaPronte.push(scheda.nome)
        continue
      }

      const righe = [[...scheda.intestazioni], ...(scheda.righe ?? [])]
      await api.scrivi(spreadsheetId, scheda.nome, righe)
      await api.congelaIntestazione(spreadsheetId, scheda.nome)
    }

    return { ok: true, create, giaPronte }
  } catch (err) {
    return {
      ok: false,
      create,
      giaPronte,
      errore: err instanceof Error ? err.message : String(err),
    }
  }
}
