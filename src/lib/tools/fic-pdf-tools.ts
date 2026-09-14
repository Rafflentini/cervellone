/**
 * src/lib/tools/fic-pdf-tools.ts — rivedere un documento EMESSO prima di
 * trasmetterlo.
 *
 * ⚠️ **Perche' esiste (14 settembre 2026).** Cervellone sa compilare fatture e
 * autofatture su Fatture in Cloud. L'Ingegnere vuole RIVEDERLE prima di
 * trasmetterle, e per farlo doveva aprire il gestionale a mano. Parole sue:
 * «se gli richiedo da Cervellone il PDF della fattura o autofattura che ha
 * compilato per controllarla, sa scaricare PDF e ridarmelo li' per
 * controllare».
 *
 * **Il tool restituisce un LINK, non il file.** Non e' una scorciatoia, e'
 * l'unica forma che rispetta la regola di casa dei DUE CANALI EQUIPOLLENTI:
 * su Telegram Cervellone sa mandare solo testo (`telegram-helpers.ts` ha
 * `sendMessage` e il download dei file in ARRIVO, non `sendDocument`), e i
 * tool ricevono `conversationId`, non l'id della chat Telegram — spingere un
 * file dentro la conversazione vorrebbe dire far passare quell'id per tutto
 * il livello dei tool, e funzionerebbe su un canale solo. Un link si apre
 * identico su Telegram e sul web.
 *
 * ⚠️ **Il link si consegna solo dopo aver preso davvero il file.** Il tool
 * scarica il PDF e ne controlla i BYTE prima di firmare il collegamento: se
 * non arriva, o se quello che arriva non e' un PDF, si dice — con lo stato
 * HTTP vero. Consegnare un link «probabilmente valido» significherebbe
 * spostare il guasto dentro il browser dell'Ingegnere, dove nessuno lo sa
 * spiegare. Costa un download in piu' (la rotta riscarica quando il link si
 * apre) ed e' un prezzo accettabile: una fattura pesa decine di KB.
 *
 * 🚨 Questo tool LEGGE. Non modifica, non trasmette allo SdI, non cancella.
 */
import type { ToolDefinition } from './types'
import { chiaveLinkPdf, pdfDocumentoEmesso } from '@/lib/fic-allegato'
import { signShareToken } from '@/lib/doc-access'
import type { CodiceSocieta } from '@/lib/societa'

/**
 * Quanto dura il collegamento.
 *
 * Mezz'ora: e' un documento fiscale con dentro i dati di clienti veri, e serve
 * per un controllo che si fa SUBITO, non per archiviarlo. Il link e' firmato
 * (HMAC su societa+id+scadenza, `doc-access.ts`) quindi non e' indovinabile,
 * ma un collegamento che non scade e' un collegamento che prima o poi finisce
 * in una chat inoltrata: se serve di nuovo, si richiede il tool.
 */
export const DURATA_LINK_MINUTI = 30

function baseUrl(): string {
  // Letta a ogni chiamata e non a modulo caricato: stessa variabile di
  // `share-proposte.ts`, stesso valore di ripiego.
  return process.env.APP_BASE_URL || 'https://cervellone-five.vercel.app'
}

export const FIC_PDF_TOOLS: ToolDefinition[] = [
  {
    name: 'fic_pdf_documento',
    description:
      'Restituisce il LINK al PDF di un documento EMESSO su Fatture in Cloud — fattura, autofattura/integrazione (reverse charge), nota di credito — dato il suo id. '
      + 'USALO quando ti chiedono di CONTROLLARE o RIVEDERE una fattura o un\'autofattura che hai compilato, o di «farmi vedere il PDF»: serve a rileggere il documento prima di trasmetterlo allo SdI, senza aprire Fatture in Cloud a mano. '
      + 'L\'id lo trovi con fic_fatture_emesse, fic_dettaglio_documento o nella risposta di conferma_bozza_fic. Vale SOLO per i documenti EMESSI: per l\'allegato di una fattura RICEVUTA usa fic_leggi_allegato_fattura. '
      + 'Riporta all\'Ingegnere il link INSIEME a numero, data, totale e tipo del documento, cosi sa che sta per aprire la cosa giusta, e digli fra quanti minuti scade. '
      + 'Il link vale solo per la societa attiva: se il documento e dell\'altra societa, cambia prima societa attiva. '
      + 'Se il PDF non si scarica il tool NON restituisce nessun link e dice il motivo con lo stato HTTP: riportalo com\'e, non trasformarlo in un generico «documento non disponibile».',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'integer',
          description: 'Id del documento EMESSO su Fatture in Cloud (il campo id, non il numero della fattura).',
        },
      },
      required: ['id'],
    },
  },
]

export async function executeFicPdfTool(
  name: string,
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string | null> {
  if (name !== 'fic_pdf_documento') return null

  const id = Number(input.id)
  if (!Number.isInteger(id) || id <= 0) {
    return JSON.stringify({
      ok: false,
      error: `id non valido: «${String(input.id ?? '')}». Serve l'id numerico del documento su Fatture in Cloud `
        + '(lo trovi con fic_fatture_emesse o fic_dettaglio_documento), non il numero della fattura.',
    })
  }

  const esito = await pdfDocumentoEmesso(id, societa)
  if (!esito.ok) {
    // Il motivo viaggia accanto al messaggio: 'nessun_url' e 'scaricamento'
    // NON sono la stessa cosa, e il modello deve poterli raccontare diversi.
    return JSON.stringify({
      ok: false,
      motivo: esito.motivo,
      error: esito.messaggio,
      documento: esito.meta ?? null,
    })
  }

  const scadenza = Math.floor(Date.now() / 1000) + DURATA_LINK_MINUTI * 60
  let token: string
  try {
    token = signShareToken(chiaveLinkPdf(societa, id), scadenza)
  } catch (err) {
    // `signShareToken` ALZA se manca AUTH_SECRET, invece di firmare un
    // collegamento indovinabile su un repository pubblico. Qui quell'eccezione
    // diventa una frase, non un turno morto.
    return JSON.stringify({
      ok: false,
      motivo: 'firma',
      error: `Ho il PDF del documento ${id} ma non posso firmare un collegamento sicuro: `
        + `${err instanceof Error ? err.message : String(err)}`,
      documento: esito.meta,
    })
  }

  const link = `${baseUrl()}/api/fic-pdf/${societa}/${id}?t=${token}&exp=${scadenza}`
  return JSON.stringify({
    ok: true,
    link,
    scade_fra_minuti: DURATA_LINK_MINUTI,
    numero: esito.meta.numero,
    data: esito.meta.data,
    totale: esito.meta.totale,
    tipo: esito.meta.tipo,
    cliente: esito.meta.cliente,
    dimensione_kb: Math.max(1, Math.round(esito.buffer.length / 1024)),
    // Dichiarato, non dedotto: al primo uso vero dice quale delle due strade
    // per scaricare da Fatture in Cloud ha funzionato (v. `fic-allegato.ts`).
    autenticazione_usata: esito.autenticazione,
    cosa_faccio_adesso:
      `Dai all'Ingegnere il link insieme a tipo, numero, data e totale, e digli che scade fra ${DURATA_LINK_MINUTI} minuti. `
      + 'Il PDF l ho gia scaricato e verificato: il link apre quel documento.',
  })
}
