/**
 * src/lib/checkin/tools.ts
 *
 * Gli strumenti del check-in de LA REAL ESTATE SRLS.
 *
 * Per ora uno solo: preparare il foglio. E' il gesto che l'app di agosto
 * affidava a una voce di menu, mai premuta — con il risultato che il foglio e'
 * rimasto vuoto e il progetto fermo per due settimane senza che nulla lo
 * segnalasse.
 */

import type { ToolDefinition } from '../tools/types'
import { inizializzaFoglioCheckin } from './foglio-init'
import { foglioGoogle } from './foglio-google'
import { FOGLIO_CHECKIN_ID } from './foglio-schema'

export const CHECKIN_TOOLS: ToolDefinition[] = [
  {
    name: 'checkin_prepara_foglio',
    description:
      "Prepara il foglio Google del check-in de LA REAL ESTATE: crea le schede Soggiorni, Ospiti, Config e Tabelle con le intestazioni corrette e i valori di partenza (unità, aliquota IVA, imposta di soggiorno di Maratea). È RIPETIBILE senza danno: le schede che già esistono e contengono dati non vengono toccate. Usalo quando l'Ingegnere chiede di preparare, inizializzare o sistemare il foglio dei check-in.",
    input_schema: {
      type: 'object',
      properties: {
        foglio_id: {
          type: 'string',
          description: `ID del foglio Google. Se omesso usa quello adottato (${FOGLIO_CHECKIN_ID}).`,
        },
      },
      required: [],
    },
  },
]

export async function executeCheckinTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'checkin_prepara_foglio') return null

  const foglioId = typeof input.foglio_id === 'string' && input.foglio_id.trim()
    ? input.foglio_id.trim()
    : FOGLIO_CHECKIN_ID

  const esito = await inizializzaFoglioCheckin(foglioId, foglioGoogle)

  return JSON.stringify({
    ok: esito.ok,
    foglio_id: foglioId,
    url: `https://docs.google.com/spreadsheets/d/${foglioId}`,
    schede_create: esito.create,
    schede_gia_pronte: esito.giaPronte,
    ...(esito.errore ? { errore: esito.errore } : {}),
  })
}
