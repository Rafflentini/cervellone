/**
 * src/lib/tools/gmail-allegati-tools.ts — leggere un allegato di Gmail.
 *
 * ⚠️ **Perché esiste (14 settembre 2026).** L'Ingegnere ha chiesto le fatture
 * Booking di La Real Estate. Il bot le ha trovate — sei, nella casella Gmail
 * collegata quel giorno — e poi ha dovuto dire: *«non ho un tool che apra un
 * allegato PDF di Gmail; ce l'ho solo per le caselle TopHost»*.
 *
 * Non era vero che non si potesse fare. Era vero che **non aveva un nome**:
 * `scaricaAllegato` (`gmail-tools.ts`) c'era già, `testoDaPdf` (`drive.ts`)
 * pure, e nessun tool le univa. Il modello conosce se stesso attraverso
 * l'elenco dei propri attrezzi: una capacità che non è un tool, per lui non
 * esiste — ed è lo stesso difetto che nel maggio 2026 gli fece dire che non
 * sapeva raccogliere le fatture estere mentre l'automazione girava da mesi.
 *
 * Gli allegati delle caselle TopHost restano su `leggi_allegato_mail`: quello
 * estrae una SCADENZA strutturata. Questo restituisce il TESTO, perché una
 * fattura Booking non è una scadenza — è un importo da leggere.
 */
import type { ToolDefinition } from './types'
import { readMessage, scaricaAllegato } from '@/lib/gmail-tools'
import { testoDaPdf } from '@/lib/drive'
import { caselleDiTrasporto, type ChiaveCasella } from '@/lib/caselle'

/** Oltre questa soglia il PDF non si apre: un allegato enorme farebbe scadere il turno. */
const MAX_BYTE = 10 * 1024 * 1024

const CASELLE_GOOGLE = caselleDiTrasporto('google').map((c) => c.chiave)

export const GMAIL_ALLEGATI_TOOLS: ToolDefinition[] = [
  {
    name: 'gmail_leggi_allegato',
    description:
      'Apre un allegato (PDF) di una mail di Gmail e ne restituisce il TESTO, per leggerne gli importi e i dati. USALO quando una mail ha un allegato e il corpo non basta: fatture Booking, ricevute, estratti conto, documenti di fornitori esteri. Serve il message_id della mail (lo trovi con gmail_search o gmail_list_inbox) e la casella. Se la mail ha un allegato solo lo apre senza chiedere altro; se ne ha piu di uno, indica nome_file. NON inventare MAI un importo che non hai letto qui dentro: se il testo non si estrae, dillo.',
    input_schema: {
      type: 'object',
      properties: {
        casella: {
          type: 'string',
          enum: CASELLE_GOOGLE,
          description: 'Da quale casella Google viene la mail. Se non la sai, guarda da dove veniva il risultato della ricerca.',
        },
        message_id: { type: 'string', description: 'Id della mail (campo id dei risultati di gmail_search / gmail_list_inbox).' },
        nome_file: { type: 'string', description: 'Nome dell allegato, se la mail ne ha piu di uno.' },
      },
      required: ['casella', 'message_id'],
    },
  },
]

export async function executeGmailAllegatiTools(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'gmail_leggi_allegato') return null

  const casella = String(input.casella ?? '') as ChiaveCasella
  if (!CASELLE_GOOGLE.includes(casella)) {
    return `Non so quale casella aprire. Dimmelo: ${CASELLE_GOOGLE.join(' oppure ')}.`
  }
  const messageId = String(input.message_id ?? '')
  if (!messageId) return 'Serve il message_id della mail: lo trovi nei risultati di gmail_search.'

  let mail
  try {
    mail = await readMessage(casella, messageId)
  } catch (e) {
    return `Non sono riuscito ad aprire la mail ${messageId} su ${casella}: ${e instanceof Error ? e.message : String(e)}`
  }

  const allegati = mail.attachments ?? []
  if (allegati.length === 0) return `La mail «${mail.subject}» non ha allegati.`

  const nomeChiesto = typeof input.nome_file === 'string' ? input.nome_file.trim() : ''
  const scelto = nomeChiesto
    ? allegati.find((a) => a.filename === nomeChiesto) ?? allegati.find((a) => a.filename.includes(nomeChiesto))
    : allegati.length === 1 ? allegati[0] : undefined

  if (!scelto) {
    // Non si sceglie per conto suo fra piu' allegati: aprire quello sbagliato
    // e leggerne gli importi produrrebbe un numero giusto del documento errato.
    const elenco = allegati.map((a) => `«${a.filename}» (${Math.round(a.sizeBytes / 1024)} KB)`).join(', ')
    return `La mail ha ${allegati.length} allegati e non so quale aprire: ${elenco}. Dimmi quale con nome_file.`
  }

  if (scelto.sizeBytes > MAX_BYTE) {
    return `L allegato «${scelto.filename}» pesa ${Math.round(scelto.sizeBytes / 1024 / 1024)} MB: troppo per aprirlo qui.`
  }

  let base64: string
  try {
    base64 = await scaricaAllegato(casella, messageId, scelto.attachmentId)
  } catch (e) {
    return `Non sono riuscito a scaricare «${scelto.filename}»: ${e instanceof Error ? e.message : String(e)}`
  }

  const buffer = Buffer.from(base64, 'base64')
  const esito = await testoDaPdf(buffer, scelto.filename)
  if (!esito.ok) {
    // Si dice che non si e' letto. Un allegato illeggibile non diventa un
    // riassunto inventato: e' il difetto peggiore che questo progetto conosce.
    return `Ho scaricato «${scelto.filename}» ma NON sono riuscito a leggerne il testo: ${esito.errore}. Non invento quello che c e scritto.`
  }

  return [
    `Allegato «${scelto.filename}» della mail «${mail.subject}» (casella ${casella}), ${esito.pagine} pagine:`,
    '',
    esito.testo,
  ].join('\n')
}
