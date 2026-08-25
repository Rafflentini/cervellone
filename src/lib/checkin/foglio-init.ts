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
  /** Scrive nuove intestazioni a partire dalla colonna indicata (0-based). */
  scriviIntestazioniInCoda(
    spreadsheetId: string,
    nome: string,
    daColonna: number,
    intestazioni: readonly string[],
  ): Promise<void>
  /** I valori di una colonna, intestazione esclusa. */
  leggiColonna(spreadsheetId: string, nome: string, indice: number): Promise<string[]>
  aggiungiInFondo(spreadsheetId: string, nome: string, righe: string[][]): Promise<void>
  congelaIntestazione(spreadsheetId: string, nome: string): Promise<void>
}

export interface EsitoInizializzazione {
  ok: boolean
  /** Schede create adesso. */
  create: string[]
  /** Schede che c'erano gia', con la loro intestazione: non toccate. */
  giaPronte: string[]
  /** Colonne nuove aggiunte in coda a schede gia' esistenti. */
  colonneAggiunte: string[]
  /** Righe di partenza comparse su una scheda gia' in uso (es. nuove impostazioni). */
  righeAggiunte: string[]
  errore?: string
}

export async function inizializzaFoglioCheckin(
  spreadsheetId: string = FOGLIO_CHECKIN_ID,
  api: FoglioApi,
): Promise<EsitoInizializzazione> {
  const create: string[] = []
  const giaPronte: string[] = []
  const colonneAggiunte: string[] = []
  const righeAggiunte: string[] = []

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
        // Lo schema cresce nel tempo. Le colonne nuove si AGGIUNGONO IN CODA,
        // mai riordinando: spostare una colonna sposterebbe i dati sotto di
        // essa, e il foglio resterebbe pieno di valori plausibili ma slittati.
        const daAggiungere = scheda.intestazioni.filter((c) => !prima.includes(c))
        if (daAggiungere.length > 0) {
          await api.scriviIntestazioniInCoda(spreadsheetId, scheda.nome, prima.length, daAggiungere)
          colonneAggiunte.push(...daAggiungere.map((c) => `${scheda.nome}: ${c}`))
        }

        /*
          Le RIGHE di partenza mancanti si aggiungono in fondo.
          Vale per il Config: quando nasce un'impostazione nuova, la sua riga
          deve comparire da sola sul foglio gia' in uso. Senza questo, ogni
          impostazione aggiunta resterebbe invisibile all'Ingegnere — che
          continuerebbe a non trovarla e a non poterla compilare.
          Si confronta la PRIMA colonna, che nel Config e' la chiave.
        */
        if ((scheda.righe ?? []).length > 0) {
          const esistenti = new Set(
            (await api.leggiColonna(spreadsheetId, scheda.nome, 0)).map((v) => v.trim()),
          )
          const righeNuove = (scheda.righe ?? []).filter((r) => !esistenti.has(String(r[0] ?? '').trim()))
          if (righeNuove.length > 0) {
            await api.aggiungiInFondo(spreadsheetId, scheda.nome, righeNuove)
            righeAggiunte.push(...righeNuove.map((r) => `${scheda.nome}: ${r[0]}`))
          }
        }
        if (!create.includes(scheda.nome)) giaPronte.push(scheda.nome)
        continue
      }

      const righe = [[...scheda.intestazioni], ...(scheda.righe ?? [])]
      await api.scrivi(spreadsheetId, scheda.nome, righe)
      await api.congelaIntestazione(spreadsheetId, scheda.nome)
    }

    return { ok: true, create, giaPronte, colonneAggiunte, righeAggiunte }
  } catch (err) {
    return {
      ok: false,
      create,
      giaPronte,
      colonneAggiunte,
      righeAggiunte,
      errore: err instanceof Error ? err.message : String(err),
    }
  }
}
